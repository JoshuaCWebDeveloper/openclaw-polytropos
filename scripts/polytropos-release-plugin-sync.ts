import { pathToFileURL } from "node:url";
import { commitPluginInstallRecordsWithConfig } from "../src/cli/plugins-install-record-commit.js";
import { extractInstalledNpmPackageName } from "../src/cli/plugins-install-records.js";
import { refreshPluginRegistryAfterConfigMutation } from "../src/cli/plugins-registry-refresh.js";
import { readConfigFileSnapshot, getRuntimeConfig } from "../src/config/config.js";
import { parseRegistryNpmSpec } from "../src/infra/npm-registry-spec.js";
import { readPackageVersion } from "../src/infra/package-json.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "../src/plugins/installed-plugin-index-records.js";
import { updateNpmInstalledPlugins } from "../src/plugins/update.js";
import {
  collectChangedExtensionIdsFromGitRange,
  collectPublishablePluginPackages,
} from "./lib/plugin-npm-release.ts";

type LoggerLine = { level: "info" | "warn" | "error"; message: string };
export type ReleasePluginSyncTarget = {
  pluginId: string;
  packageName: string;
  installedVersion: string;
  releaseVersion: string;
  specOverride: string;
};

export function resolveReleaseManagedNpmPluginTargets(params: {
  repoRoot: string;
  installRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  gitRange?: { baseRef: string; headRef: string };
}): ReleasePluginSyncTarget[] {
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
      installedVersion,
      releaseVersion: publishable.version,
      specOverride: `${packageName}@${publishable.version}`,
    });
  }

  return targets.sort((left, right) => left.pluginId.localeCompare(right.pluginId));
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
  const targets = resolveReleaseManagedNpmPluginTargets({
    repoRoot,
    installRecords,
    gitRange: baseRef && headRef ? { baseRef, headRef } : undefined,
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

  const result = await updateNpmInstalledPlugins({
    config: withPluginInstallRecords(cfg, installRecords),
    pluginIds: targets.map((entry) => entry.pluginId),
    forceReinstallPluginIds: new Set(targets.map((entry) => entry.pluginId)),
    specOverrides: Object.fromEntries(
      targets.map((entry) => [entry.pluginId, entry.specOverride] as const),
    ),
    logger,
    onIntegrityDrift: async () => false,
  });

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
