import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { commitPluginInstallRecordsWithConfig } from "../src/cli/plugins-install-record-commit.js";
import { extractInstalledNpmPackageName } from "../src/cli/plugins-install-records.js";
import { refreshPluginRegistryAfterConfigMutation } from "../src/cli/plugins-registry-refresh.js";
import { readConfigFileSnapshot, getRuntimeConfig } from "../src/config/config.js";
import type { PluginInstallRecord } from "../src/config/types.plugins.js";
import { parseRegistryNpmSpec } from "../src/infra/npm-registry-spec.js";
import { readPackageVersion } from "../src/infra/package-json.js";
import { installPluginFromArchive, resolvePluginInstallDir } from "../src/plugins/install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "../src/plugins/installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "../src/plugins/installs.js";
import {
  collectChangedExtensionIdsFromGitRange,
  collectPublishablePluginPackages,
} from "./lib/plugin-npm-release.ts";

type LoggerLine = { level: "info" | "warn" | "error"; message: string };

type PackageInventoryEntry = {
  packageName: string;
  packageType: "core" | "plugin";
  latestVersion: string | null;
  changed: boolean;
  artifactUrl: string | null;
  integrity: string | null;
  publishedPackageName?: string;
};

type PackageInventory = {
  packages?: PackageInventoryEntry[];
};

export type ReleasePluginSyncTarget = {
  pluginId: string;
  packageName: string;
  registryPackageName: string;
  installedVersion: string;
  releaseVersion: string;
  specOverride: string;
  artifactUrl?: string;
  integrity?: string | null;
};

function resolveHome() {
  return process.env.HOME || os.homedir() || "/home/ec2-user";
}

function resolvePolytroposReleasesRoot() {
  return path.join(resolveHome(), "polytropos", "releases");
}

function resolvePluginReleaseStageDir() {
  return path.join(resolvePolytroposReleasesRoot(), "plugins");
}

function resolveInventoryPath(headRef: string | undefined): string | null {
  if (!headRef || !/^v.+-poly\.\d+$/.test(headRef)) {
    return null;
  }
  return path.join(resolvePolytroposReleasesRoot(), `${headRef}.package-inventory.json`);
}

function loadReleaseInventory(headRef: string | undefined): PackageInventory | null {
  const inventoryPath = resolveInventoryPath(headRef);
  if (!inventoryPath || !fs.existsSync(inventoryPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as PackageInventory;
  return parsed && Array.isArray(parsed.packages) ? parsed : null;
}

function sanitizeArtifactFileName(params: {
  packageName: string;
  version: string;
  artifactUrl: string;
}) {
  try {
    const candidate = path.basename(new URL(params.artifactUrl).pathname);
    if (candidate && candidate.endsWith(".tgz")) {
      return candidate;
    }
  } catch {}
  return `${params.packageName.replaceAll("/", "-").replaceAll("@", "")}-${params.version}.tgz`;
}

async function downloadArtifactToFile(url: string, targetPath: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`artifact download failed: ${url} (HTTP ${response.status})`);
  }
  const tempPath = `${targetPath}.tmp`;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.promises.rm(tempPath, { force: true });
  try {
    await pipeline(response.body, createWriteStream(tempPath));
    await fs.promises.rename(tempPath, targetPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true });
  }
}

async function stageRegistryPackageArchive(params: {
  packageName: string;
  version: string;
  targetPath: string;
}) {
  const stagingDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "openclaw-polytropos-plugin-pack-"),
  );
  await fs.promises.mkdir(path.dirname(params.targetPath), { recursive: true });
  try {
    const rawOutput = execFileSync(
      "npm",
      [
        "pack",
        `${params.packageName}@${params.version}`,
        "--pack-destination",
        stagingDir,
        "--silent",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const fileName = rawOutput
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!fileName) {
      throw new Error(
        `npm pack did not report an archive filename for ${params.packageName}@${params.version}`,
      );
    }
    const stagedPackPath = path.join(stagingDir, fileName);
    if (!fs.existsSync(stagedPackPath)) {
      throw new Error(
        `npm pack did not produce ${fileName} for ${params.packageName}@${params.version}`,
      );
    }
    await fs.promises.rm(params.targetPath, { force: true });
    await fs.promises.copyFile(stagedPackPath, params.targetPath);
    await fs.promises.rm(stagedPackPath, { force: true });
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}

function resolveRecordedExtensionsDir(params: {
  pluginId: string;
  installPath: string;
}): string | undefined {
  const parentDir = path.dirname(params.installPath);
  try {
    const canonicalInstallPath = resolvePluginInstallDir(params.pluginId, parentDir);
    return canonicalInstallPath === params.installPath ? parentDir : undefined;
  } catch {
    return undefined;
  }
}

export function resolveReleaseManagedNpmPluginTargets(params: {
  repoRoot: string;
  installRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  gitRange?: { baseRef: string; headRef: string };
  inventory?: PackageInventory | null;
}): ReleasePluginSyncTarget[] {
  const inventoryPackages =
    params.inventory?.packages?.filter(
      (entry): entry is PackageInventoryEntry =>
        entry.packageType === "plugin" &&
        typeof entry.packageName === "string" &&
        typeof entry.latestVersion === "string" &&
        entry.changed === true,
    ) ?? [];

  if (inventoryPackages.length > 0) {
    const packageByName = new Map(
      inventoryPackages.map((entry) => [entry.packageName, entry] as const),
    );
    const targets: ReleasePluginSyncTarget[] = [];
    for (const [pluginId, record] of Object.entries(params.installRecords)) {
      if (record?.source !== "npm") {
        continue;
      }
      const packageName = extractInstalledNpmPackageName(record);
      const installedVersion = record.resolvedVersion ?? record.version;
      if (!packageName || !installedVersion) {
        continue;
      }
      const entry = packageByName.get(packageName);
      if (!entry?.artifactUrl || !entry.latestVersion) {
        continue;
      }
      targets.push({
        pluginId,
        packageName,
        registryPackageName: entry.publishedPackageName?.trim() || packageName,
        installedVersion,
        releaseVersion: entry.latestVersion,
        specOverride: `${packageName}@${entry.latestVersion}`,
        artifactUrl: entry.artifactUrl,
        integrity: entry.integrity,
      });
    }
    return targets.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  }

  const changedExtensionIds = params.gitRange
    ? collectChangedExtensionIdsFromGitRange({
        rootDir: params.repoRoot,
        gitRange: params.gitRange,
      })
    : [];
  const publishablePlugins = collectPublishablePluginPackages(params.repoRoot, {
    extensionIds: params.gitRange ? changedExtensionIds : undefined,
  });
  const publishableByPackageName = new Map(
    publishablePlugins.map((plugin) => {
      const installPackageName =
        parseRegistryNpmSpec(plugin.installNpmSpec)?.name ?? plugin.packageName;
      return [installPackageName, plugin] as const;
    }),
  );
  const targets: ReleasePluginSyncTarget[] = [];

  for (const [pluginId, record] of Object.entries(params.installRecords)) {
    if (record?.source !== "npm") {
      continue;
    }
    const packageName = extractInstalledNpmPackageName(record);
    const installedVersion = record.resolvedVersion ?? record.version;
    if (!packageName || !installedVersion) {
      continue;
    }
    const publishable = publishableByPackageName.get(packageName);
    if (!publishable) {
      continue;
    }
    targets.push({
      pluginId,
      packageName,
      registryPackageName: packageName,
      installedVersion,
      releaseVersion: publishable.version,
      specOverride: `${packageName}@${publishable.version}`,
    });
  }

  return targets.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

async function installPluginTargetsFromInventory(params: {
  configWithRecords: ReturnType<typeof withPluginInstallRecords>;
  installRecords: Record<string, PluginInstallRecord>;
  targets: ReleasePluginSyncTarget[];
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}): Promise<{
  config: ReturnType<typeof withPluginInstallRecords>;
  changed: boolean;
  outcomes: Array<{ pluginId: string; status: "updated" | "unchanged" | "error"; message: string }>;
}> {
  let next = params.configWithRecords;
  let changed = false;
  const outcomes: Array<{
    pluginId: string;
    status: "updated" | "unchanged" | "error";
    message: string;
  }> = [];

  for (const target of params.targets) {
    if (!target.artifactUrl) {
      outcomes.push({
        pluginId: target.pluginId,
        status: "error",
        message: `Missing artifact URL for ${target.packageName}@${target.releaseVersion}.`,
      });
      continue;
    }
    if (target.installedVersion === target.releaseVersion) {
      outcomes.push({
        pluginId: target.pluginId,
        status: "unchanged",
        message: `${target.pluginId} is up to date (${target.installedVersion}).`,
      });
      continue;
    }

    const fileName = sanitizeArtifactFileName({
      packageName: target.packageName,
      version: target.releaseVersion,
      artifactUrl: target.artifactUrl,
    });
    const stagedArtifactPath = path.join(resolvePluginReleaseStageDir(), fileName);
    try {
      try {
        await stageRegistryPackageArchive({
          packageName: target.registryPackageName,
          version: target.releaseVersion,
          targetPath: stagedArtifactPath,
        });
      } catch (npmPackError) {
        params.logger.warn(
          `npm pack failed for ${target.registryPackageName}@${target.releaseVersion}; falling back to artifact URL download: ${String(
            npmPackError,
          )}`,
        );
        await downloadArtifactToFile(target.artifactUrl, stagedArtifactPath);
      }
      const existingRecord = params.installRecords[target.pluginId];
      const extensionsDir = existingRecord?.installPath
        ? resolveRecordedExtensionsDir({
            pluginId: target.pluginId,
            installPath: existingRecord.installPath,
          })
        : undefined;
      const result = await installPluginFromArchive({
        archivePath: stagedArtifactPath,
        mode: "update",
        expectedPluginId: target.pluginId,
        ...(extensionsDir ? { extensionsDir } : {}),
      });
      if (!result.ok) {
        outcomes.push({
          pluginId: target.pluginId,
          status: "error",
          message: `Failed to update ${target.pluginId}: ${result.error}`,
        });
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId: result.pluginId,
        source: "npm",
        spec: target.specOverride,
        installPath: result.targetDir,
        version: result.version ?? target.releaseVersion,
        ...buildNpmResolutionInstallFields({
          name: target.packageName,
          version: target.releaseVersion,
          resolvedSpec: target.specOverride,
          integrity: target.integrity ?? undefined,
          resolvedAt: new Date().toISOString(),
        }),
      });
      changed = true;
      outcomes.push({
        pluginId: target.pluginId,
        status: "updated",
        message: `Updated ${target.pluginId}: ${target.installedVersion} -> ${target.releaseVersion}.`,
      });
    } catch (error) {
      outcomes.push({
        pluginId: target.pluginId,
        status: "error",
        message: `Failed to update ${target.pluginId}: ${String(error)}`,
      });
    }
  }

  return { config: next, changed, outcomes };
}

async function main() {
  const installedRoot = process.argv[2];
  const baseRef = process.argv[3];
  const headRef = process.argv[4];
  const repoRoot = process.cwd();
  if (!installedRoot) {
    throw new Error(
      "Usage: tsx scripts/polytropos-release-plugin-sync.ts <installed-openclaw-root> [baseRef headRef]",
    );
  }

  const gatewayVersion = await readPackageVersion(installedRoot);
  if (!gatewayVersion) {
    throw new Error(`Could not read installed OpenClaw version from ${installedRoot}`);
  }

  const sourceSnapshotPromise = readConfigFileSnapshot({ skipPluginValidation: true }).catch(
    () => null,
  );
  const cfg = getRuntimeConfig();
  const installRecords = await loadInstalledPluginIndexInstallRecords();
  const inventory = loadReleaseInventory(headRef);
  const targets = resolveReleaseManagedNpmPluginTargets({
    repoRoot,
    installRecords,
    gitRange: baseRef && headRef ? { baseRef, headRef } : undefined,
    inventory,
  });
  const loggerLines: LoggerLine[] = [];

  if (targets.length === 0) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        gatewayVersion,
        updated: [],
        changed: false,
        message: "No managed npm plugin installs needed release-version sync.",
      }) + "\n",
    );
    return;
  }

  const logger = {
    info: (message: string) => loggerLines.push({ level: "info", message }),
    warn: (message: string) => loggerLines.push({ level: "warn", message }),
    error: (message: string) => loggerLines.push({ level: "error", message }),
  };

  const result =
    inventory !== null
      ? await installPluginTargetsFromInventory({
          configWithRecords: withPluginInstallRecords(cfg, installRecords),
          installRecords,
          targets,
          logger,
        })
      : await (async () => {
          const { updateNpmInstalledPlugins } = await import("../src/plugins/update.js");
          return await updateNpmInstalledPlugins({
            config: withPluginInstallRecords(cfg, installRecords),
            pluginIds: targets.map((entry) => entry.pluginId),
            forceReinstallPluginIds: new Set(targets.map((entry) => entry.pluginId)),
            specOverrides: Object.fromEntries(
              targets.map((entry) => [entry.pluginId, entry.specOverride] as const),
            ),
            logger,
            onIntegrityDrift: async () => false,
          });
        })();

  if (result.changed) {
    const nextInstallRecords = result.config.plugins?.installs ?? {};
    const nextConfig = withoutPluginInstallRecords(result.config);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: installRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: (await sourceSnapshotPromise)?.hash,
      writeOptions: {
        afterWrite: { mode: "restart", reason: "release plugin sync" },
      },
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      installRecords: nextInstallRecords,
      logger,
    });
  }

  const errored = result.outcomes.some((outcome) => outcome.status === "error");
  process.stdout.write(
    JSON.stringify({
      ok: !errored,
      gatewayVersion,
      inventoryUsed: inventory !== null,
      targets,
      changed: result.changed,
      outcomes: result.outcomes,
      logs: loggerLines,
    }) + "\n",
  );

  if (errored) {
    process.exitCode = 1;
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  await main();
}
