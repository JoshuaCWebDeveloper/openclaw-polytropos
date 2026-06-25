import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { commitPluginInstallRecordsWithConfig } from "../src/cli/plugins-install-record-commit.js";
import { extractInstalledNpmPackageName } from "../src/cli/plugins-install-records.js";
import { refreshPluginRegistryAfterConfigMutation } from "../src/cli/plugins-registry-refresh.js";
import { readConfigFileSnapshot, getRuntimeConfig } from "../src/config/config.js";
import type { PluginInstallRecord } from "../src/config/types.plugins.js";
import { parseRegistryNpmSpec } from "../src/infra/npm-registry-spec.js";
import { readPackageVersion } from "../src/infra/package-json.js";
import {
  installedPackageNeedsOpenClawPeerLinkRepair,
  readInstalledPackagePeerDependencies,
} from "../src/infra/package-update-utils.js";
import { installPluginFromArchive, resolvePluginInstallDir } from "../src/plugins/install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "../src/plugins/installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields, recordPluginInstall } from "../src/plugins/installs.js";
import { resolveUserPath } from "../src/utils.js";
import {
  collectChangedExtensionIdsFromGitRange,
  collectPublishablePluginPackages,
} from "./lib/plugin-npm-release.ts";
import { ensureStoredReleasePackage } from "./lib/polytropos-release-package-store.mjs";

type LoggerLine = { level: "info" | "warn" | "error"; message: string };

type PackageInventoryEntry = {
  packageName: string;
  packageType: "core" | "plugin";
  latestVersion: string | null;
  changed: boolean;
  artifactUrl: string | null;
  integrity: string | null;
  extensionId?: string;
  publishedPackageName?: string;
};

type PackageInventory = {
  packages?: PackageInventoryEntry[];
};

type PeerLinkRepairSummary = {
  checked: number;
  attempted: number;
  repaired: number;
  skipped: number;
};

function openClawPeerLinkNeedsReleaseRepair(params: {
  hostRoot: string;
  installPath: string;
}): boolean {
  if (installedPackageNeedsOpenClawPeerLinkRepair(params.installPath)) {
    return true;
  }
  const linkPath = path.join(params.installPath, "node_modules", "openclaw");
  try {
    return fs.realpathSync(linkPath) !== fs.realpathSync(params.hostRoot);
  } catch {
    return true;
  }
}

export type ReleasePluginSyncTarget = {
  pluginId: string;
  packageName: string;
  registryPackageName: string;
  installedVersion: string | null;
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

function resolveInventoryPath(headRef: string | undefined): string | null {
  if (!headRef || !/^v.+-poly\.\d+$/.test(headRef)) {
    return null;
  }
  const releasesRoot = resolvePolytroposReleasesRoot();
  const inventoryPath = path.join(releasesRoot, `${headRef}.json`);
  if (fs.existsSync(inventoryPath)) {
    return inventoryPath;
  }
  const legacyInventoryPath = path.join(releasesRoot, `${headRef}.package-inventory.json`);
  return fs.existsSync(legacyInventoryPath) ? legacyInventoryPath : inventoryPath;
}

function loadReleaseInventory(headRef: string | undefined): PackageInventory | null {
  const inventoryPath = resolveInventoryPath(headRef);
  if (!inventoryPath || !fs.existsSync(inventoryPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8")) as PackageInventory;
  return parsed && Array.isArray(parsed.packages) ? parsed : null;
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
        typeof entry.extensionId === "string" &&
        entry.extensionId.trim().length > 0 &&
        typeof entry.latestVersion === "string" &&
        entry.latestVersion.trim().length > 0,
    ) ?? [];

  if (inventoryPackages.length > 0) {
    const installRecordEntries = Object.entries(params.installRecords).filter(
      ([, record]) => record?.source === "npm",
    );
    const installRecordByPluginId = new Map(installRecordEntries);
    const targets: ReleasePluginSyncTarget[] = [];
    for (const entry of inventoryPackages) {
      if (!entry.artifactUrl || !entry.latestVersion) {
        continue;
      }
      const pluginId = entry.extensionId!.trim();
      const record = installRecordByPluginId.get(pluginId);
      const installedVersion = record ? (record.resolvedVersion ?? record.version ?? null) : null;
      targets.push({
        pluginId,
        packageName: entry.packageName,
        registryPackageName: entry.publishedPackageName?.trim() || entry.packageName,
        installedVersion,
        releaseVersion: entry.latestVersion,
        specOverride: `${entry.packageName}@${entry.latestVersion}`,
        artifactUrl: entry.artifactUrl,
        integrity: entry.integrity,
      });
    }
    return targets.toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
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

  return targets.toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
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

    try {
      const stagedArtifactPath = await ensureStoredReleasePackage({
        relRoot: resolvePolytroposReleasesRoot(),
        packageName: target.packageName,
        registryPackageName: target.registryPackageName,
        version: target.releaseVersion,
        artifactUrl: target.artifactUrl,
        logger: params.logger,
      });
      const existingRecord = params.installRecords[target.pluginId];
      const extensionsDir = existingRecord?.installPath
        ? resolveRecordedExtensionsDir({
            pluginId: target.pluginId,
            installPath: existingRecord.installPath,
          })
        : undefined;
      const result = await installPluginFromArchive({
        archivePath: stagedArtifactPath,
        mode: existingRecord ? "update" : "install",
        expectedPluginId: target.pluginId,
        trustedSourceLinkedOfficialInstall: true,
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
        message: `${existingRecord ? "Updated" : "Installed"} ${target.pluginId}: ${target.installedVersion ?? "<missing>"} -> ${target.releaseVersion}.`,
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

export async function repairOpenClawPeerLinksForReleaseInstall(params: {
  hostRoot: string;
  installRecords: Record<string, PluginInstallRecord>;
  logger: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}): Promise<PeerLinkRepairSummary> {
  let checked = 0;
  let attempted = 0;
  let repaired = 0;
  let skipped = 0;

  for (const [pluginId, record] of Object.entries(params.installRecords)) {
    if (record?.source !== "npm") {
      continue;
    }
    let installPath: string;
    try {
      installPath = resolveUserPath(
        record.installPath?.trim() || resolvePluginInstallDir(pluginId),
      );
    } catch (error) {
      params.logger.warn(
        `Could not repair openclaw peer link for ${pluginId}: invalid install path (${String(
          error,
        )}).`,
      );
      skipped += 1;
      continue;
    }

    if (!openClawPeerLinkNeedsReleaseRepair({ hostRoot: params.hostRoot, installPath })) {
      checked += 1;
      continue;
    }

    const peerDependencies = readInstalledPackagePeerDependencies(installPath);
    if (!Object.hasOwn(peerDependencies, "openclaw")) {
      checked += 1;
      continue;
    }

    checked += 1;
    attempted += 1;
    const nodeModulesDir = path.join(installPath, "node_modules");
    const linkPath = path.join(nodeModulesDir, "openclaw");
    try {
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      const existing = fs.lstatSync(linkPath, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isSymbolicLink()) {
          const packageJsonPath = path.join(linkPath, "package.json");
          const existingPackageName = fs.existsSync(packageJsonPath)
            ? (JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { name?: unknown }).name
            : undefined;
          if (existingPackageName !== "openclaw") {
            params.logger.warn(
              `Could not repair openclaw peer link for ${pluginId} at ${installPath}: ${linkPath} already exists and is not an openclaw package.`,
            );
            skipped += 1;
            continue;
          }
        }
        fs.rmSync(linkPath, { recursive: true, force: true });
      }
      fs.symlinkSync(params.hostRoot, linkPath, "junction");
      params.logger.info(`Linked peerDependency "openclaw" -> ${params.hostRoot}`);
    } catch (error) {
      params.logger.warn(
        `Could not repair openclaw peer link for ${pluginId} at ${installPath}: ${String(error)}.`,
      );
      skipped += 1;
      continue;
    }
    repaired += openClawPeerLinkNeedsReleaseRepair({ hostRoot: params.hostRoot, installPath })
      ? 0
      : 1;
  }

  return { checked, attempted, repaired, skipped };
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

  const logger = {
    info: (message: string) => loggerLines.push({ level: "info", message }),
    warn: (message: string) => loggerLines.push({ level: "warn", message }),
    error: (message: string) => loggerLines.push({ level: "error", message }),
  };

  const result =
    targets.length === 0
      ? {
          config: withPluginInstallRecords(cfg, installRecords),
          changed: false,
          outcomes: [],
        }
      : inventory !== null
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
  const nextInstallRecords = result.config.plugins?.installs ?? installRecords;
  const peerLinkRepair = await repairOpenClawPeerLinksForReleaseInstall({
    hostRoot: installedRoot,
    installRecords: nextInstallRecords,
    logger,
  });

  const errored = result.outcomes.some((outcome) => outcome.status === "error");
  process.stdout.write(
    JSON.stringify({
      ok: !errored,
      gatewayVersion,
      inventoryUsed: inventory !== null,
      targets,
      changed: result.changed,
      outcomes: result.outcomes,
      peerLinkRepair,
      logs: loggerLines,
      ...(targets.length === 0
        ? { message: "No managed npm plugin installs needed release-version sync." }
        : {}),
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
