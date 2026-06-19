#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectChangedPathsFromGitRange,
  collectExtensionPackageJsonCandidates,
  parsePluginReleaseSelection,
  type PluginPackageJson,
} from "./lib/plugin-npm-release.ts";

type PackageInventoryEntry = {
  packageName: string;
  packageType: "core" | "plugin";
  baseVersion: string | null;
  latestVersion: string | null;
  changed: boolean;
  publishedInRun: boolean;
  artifactUrl: string | null;
  integrity: string | null;
  packageDir?: string;
  extensionId?: string;
  diffRoots: string[];
  source: "github-actions-artifact";
};

type PackageInventory = {
  generatedAt: string;
  releaseTag: string | null;
  repository: string | null;
  workflowRunId: string | null;
  trackedPackagesFile: string;
  packages: PackageInventoryEntry[];
};

type CliOptions = {
  trackedPackagesFile: string;
  outputFile: string;
  releaseTag: string | null;
  repository: string | null;
  workflowRunId: string | null;
  coreArtifactUrl: string | null;
  coreArtifactFile: string | null;
  pluginArtifactsFile: string | null;
  pluginSelection: string[];
  baseRef: string | null;
  headRef: string | null;
};

type PluginArtifactMetadata = {
  packageName: string;
  artifactUrl: string;
  artifactFile?: string | null;
  version?: string | null;
};

const SHARED_PLUGIN_PATHS = [
  "scripts/lib/plugin-npm-runtime-build.mjs",
  "scripts/lib/plugin-npm-package-manifest.mjs",
  "scripts/lib/plugin-npm-runtime-assets.mjs",
  "scripts/lib/static-extension-assets.mjs",
  "scripts/lib/bundled-plugin-build-entries.mjs",
  "src/config/bundled-channel-config-metadata.generated.ts",
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): CliOptions {
  let trackedPackagesFile = ".github/polytropos-tracked-packages.json";
  let outputFile = ".local/polytropos-package-inventory.json";
  let releaseTag: string | null = null;
  let repository: string | null = null;
  let workflowRunId: string | null = null;
  let coreArtifactUrl: string | null = null;
  let coreArtifactFile: string | null = null;
  let pluginArtifactsFile: string | null = null;
  let baseRef: string | null = null;
  let headRef: string | null = null;
  let pluginSelection: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--tracked-packages-file":
        trackedPackagesFile = next ?? fail("--tracked-packages-file requires a value");
        index += 1;
        break;
      case "--output":
        outputFile = next ?? fail("--output requires a value");
        index += 1;
        break;
      case "--release-tag":
        releaseTag = next ?? fail("--release-tag requires a value");
        index += 1;
        break;
      case "--repository":
        repository = next ?? fail("--repository requires a value");
        index += 1;
        break;
      case "--workflow-run-id":
        workflowRunId = next ?? fail("--workflow-run-id requires a value");
        index += 1;
        break;
      case "--core-artifact-url":
        coreArtifactUrl = next ?? fail("--core-artifact-url requires a value");
        index += 1;
        break;
      case "--core-artifact-file":
        coreArtifactFile = next ?? fail("--core-artifact-file requires a value");
        index += 1;
        break;
      case "--plugin-artifacts-file":
        pluginArtifactsFile = next ?? fail("--plugin-artifacts-file requires a value");
        index += 1;
        break;
      case "--base-ref":
        baseRef = next ?? fail("--base-ref requires a value");
        index += 1;
        break;
      case "--head-ref":
        headRef = next ?? fail("--head-ref requires a value");
        index += 1;
        break;
      case "--plugins":
        pluginSelection = parsePluginReleaseSelection(next);
        index += 1;
        break;
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    fail("Both --base-ref and --head-ref are required together.");
  }

  return {
    trackedPackagesFile,
    outputFile,
    releaseTag,
    repository,
    workflowRunId,
    coreArtifactUrl,
    coreArtifactFile,
    pluginArtifactsFile,
    pluginSelection,
    baseRef,
    headRef,
  };
}

function readTrackedPackages(filePath: string): string[] {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    fail(`Tracked package file must be a JSON string array: ${resolved}`);
  }
  return [...new Set(parsed.map((entry) => entry.trim()))];
}

function readRootPackageVersion(): string {
  const rootPackageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
    version?: string;
  };
  const version = rootPackageJson.version?.trim();
  if (!version) {
    fail("Root package.json is missing version.");
  }
  return version;
}

function sha256File(filePath: string): string {
  return execFileSync("sha256sum", [filePath], { encoding: "utf8" }).trim().split(/\s+/)[0] ?? "";
}

function readPluginArtifacts(
  filePath: string | null,
): Map<string, Required<Pick<PluginArtifactMetadata, "artifactUrl">> & PluginArtifactMetadata> {
  if (!filePath) {
    return new Map();
  }
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    fail(`Plugin artifacts file must be a JSON array: ${resolved}`);
  }
  const entries = new Map<
    string,
    Required<Pick<PluginArtifactMetadata, "artifactUrl">> & PluginArtifactMetadata
  >();
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.packageName !== "string" ||
      !entry.packageName.trim() ||
      typeof entry.artifactUrl !== "string" ||
      !entry.artifactUrl.trim()
    ) {
      fail(`Plugin artifacts file contains an invalid entry: ${resolved}`);
    }
    entries.set(entry.packageName.trim(), {
      packageName: entry.packageName.trim(),
      artifactUrl: entry.artifactUrl.trim(),
      artifactFile:
        typeof entry.artifactFile === "string" && entry.artifactFile.trim()
          ? entry.artifactFile.trim()
          : null,
      version:
        typeof entry.version === "string" && entry.version.trim() ? entry.version.trim() : null,
    });
  }
  return entries;
}

function collectChangedPluginPackageNames(params: {
  rootDir: string;
  baseRef: string;
  headRef: string;
}): Set<string> {
  const changedPaths = collectChangedPathsFromGitRange({
    rootDir: params.rootDir,
    gitRange: { baseRef: params.baseRef, headRef: params.headRef },
    pathspecs: ["extensions", ...SHARED_PLUGIN_PATHS],
  });
  const sharedChanged = changedPaths.some((entry) => SHARED_PLUGIN_PATHS.includes(entry as never));
  if (sharedChanged) {
    return new Set(
      collectExtensionPackageJsonCandidates<PluginPackageJson>(params.rootDir)
        .filter((candidate) => candidate.packageJson.openclaw?.release?.publishToNpm === true)
        .map((candidate) => candidate.packageJson.name?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    );
  }

  const changedExtensionIds = new Set(
    changedPaths.map((entry) => entry.match(/^extensions\/([^/]+)\//)?.[1] ?? "").filter(Boolean),
  );

  return new Set(
    collectExtensionPackageJsonCandidates<PluginPackageJson>(params.rootDir)
      .filter((candidate) => changedExtensionIds.has(candidate.extensionId))
      .map((candidate) => candidate.packageJson.name?.trim())
      .filter((entry): entry is string => Boolean(entry)),
  );
}

function buildCoreEntry(options: CliOptions): PackageInventoryEntry {
  return {
    packageName: "openclaw",
    packageType: "core",
    baseVersion: null,
    latestVersion: readRootPackageVersion(),
    changed: true,
    publishedInRun: Boolean(options.releaseTag),
    artifactUrl: options.coreArtifactUrl,
    integrity:
      options.coreArtifactFile && fs.existsSync(path.resolve(options.coreArtifactFile))
        ? `sha256:${sha256File(path.resolve(options.coreArtifactFile))}`
        : null,
    diffRoots: ["*"],
    source: "github-actions-artifact",
  };
}

function buildPluginEntries(
  options: CliOptions,
  trackedPackages: string[],
): PackageInventoryEntry[] {
  const rootDir = path.resolve(".");
  const candidates = collectExtensionPackageJsonCandidates<PluginPackageJson>(rootDir);
  const trackedPlugins = trackedPackages.filter((packageName) => packageName !== "openclaw");
  const candidateByPackageName = new Map(
    candidates
      .map((candidate) => {
        const packageName = candidate.packageJson.name?.trim();
        return packageName ? ([packageName, candidate] as const) : null;
      })
      .filter((entry): entry is readonly [string, (typeof candidates)[number]] => Boolean(entry)),
  );
  const selectedPlugins =
    options.pluginSelection.length > 0 ? new Set(options.pluginSelection) : new Set(trackedPlugins);
  const pluginArtifacts = readPluginArtifacts(options.pluginArtifactsFile);
  const changedPackages =
    options.baseRef && options.headRef
      ? collectChangedPluginPackageNames({
          rootDir,
          baseRef: options.baseRef,
          headRef: options.headRef,
        })
      : new Set<string>(selectedPlugins);

  return trackedPlugins.map((packageName) => {
    const candidate = candidateByPackageName.get(packageName);
    if (!candidate) {
      fail(`Tracked plugin package does not resolve to extensions/*/package.json: ${packageName}`);
    }
    const artifact = pluginArtifacts.get(packageName);
    const version = artifact?.version ?? candidate.packageJson.version?.trim() ?? null;
    return {
      packageName,
      packageType: "plugin",
      baseVersion: version,
      latestVersion: version,
      changed: selectedPlugins.has(packageName) && changedPackages.has(packageName),
      publishedInRun: Boolean(artifact),
      artifactUrl: artifact?.artifactUrl ?? null,
      integrity:
        artifact?.artifactFile && fs.existsSync(path.resolve(artifact.artifactFile))
          ? `sha256:${sha256File(path.resolve(artifact.artifactFile))}`
          : null,
      packageDir: candidate.packageDir,
      extensionId: candidate.extensionId,
      diffRoots: [candidate.packageDir],
      source: "github-actions-artifact",
    };
  });
}

export function generatePackageInventory(options: CliOptions): PackageInventory {
  const trackedPackages = readTrackedPackages(options.trackedPackagesFile);
  if (!trackedPackages.includes("openclaw")) {
    fail('Tracked package file must include "openclaw".');
  }

  return {
    generatedAt: new Date().toISOString(),
    releaseTag: options.releaseTag,
    repository: options.repository,
    workflowRunId: options.workflowRunId,
    trackedPackagesFile: path.relative(
      path.resolve("."),
      path.resolve(options.trackedPackagesFile),
    ),
    packages: [buildCoreEntry(options), ...buildPluginEntries(options, trackedPackages)],
  };
}

function writeInventory(outputFile: string, inventory: PackageInventory) {
  const resolved = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(inventory, null, 2) + "\n", "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  const inventory = generatePackageInventory(options);
  writeInventory(options.outputFile, inventory);
  console.log(JSON.stringify(inventory, null, 2));
}
