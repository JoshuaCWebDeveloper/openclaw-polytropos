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
import {
  GITHUB_PACKAGES_REGISTRY_URL,
  resolvePolytroposGithubPublishedPackageName,
  resolvePolytroposPackageVersionFromReleaseTag,
} from "./lib/polytropos-github-packages.ts";

type PackageInventoryEntry = {
  packageName: string;
  packageType: "core" | "plugin";
  baseVersion: string | null;
  latestVersion: string | null;
  changed: boolean;
  publishedInRun: boolean;
  artifactUrl: string | null;
  integrity: string | null;
  publishedPackageName?: string;
  packageDir?: string;
  extensionId?: string;
  diffRoots: string[];
  source: "github-package-registry";
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
  githubPackageScope: string | null;
  packageRegistryUrl: string;
  publishedVersion: string | null;
  pluginSelection: string[];
  baseRef: string | null;
  headRef: string | null;
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
  let githubPackageScope: string | null = null;
  let packageRegistryUrl = GITHUB_PACKAGES_REGISTRY_URL;
  let publishedVersion: string | null = null;
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
      case "--github-package-scope":
        githubPackageScope = next ?? fail("--github-package-scope requires a value");
        index += 1;
        break;
      case "--package-registry-url":
        packageRegistryUrl = next ?? fail("--package-registry-url requires a value");
        index += 1;
        break;
      case "--published-version":
        publishedVersion = next ?? fail("--published-version requires a value");
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
    githubPackageScope,
    packageRegistryUrl,
    publishedVersion,
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

function npmViewJson(
  spec: string,
  packageRegistryUrl: string,
): {
  version?: string;
  dist?: { tarball?: string; integrity?: string; shasum?: string };
} | null {
  try {
    const raw = execFileSync("npm", ["view", spec, "--json", "--registry", packageRegistryUrl], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as
      | { version?: string; dist?: { tarball?: string; integrity?: string; shasum?: string } }
      | Array<{
          version?: string;
          dist?: { tarball?: string; integrity?: string; shasum?: string };
        }>;
    return Array.isArray(parsed) ? (parsed.at(-1) ?? null) : parsed;
  } catch {
    return null;
  }
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

function requireGithubPackageScope(options: CliOptions): string {
  const scope = options.githubPackageScope?.trim();
  if (!scope) {
    fail("--github-package-scope is required");
  }
  return scope;
}

function resolvePublishedVersion(options: CliOptions): string {
  const explicit = options.publishedVersion?.trim();
  if (explicit) {
    return explicit;
  }
  const releaseTag = options.releaseTag?.trim();
  if (releaseTag) {
    return resolvePolytroposPackageVersionFromReleaseTag(releaseTag);
  }
  return readRootPackageVersion();
}

function buildCoreEntry(options: CliOptions): PackageInventoryEntry {
  const publishedVersion = resolvePublishedVersion(options);
  const publishedPackageName = resolvePolytroposGithubPublishedPackageName({
    packageName: "openclaw",
    githubScope: requireGithubPackageScope(options),
  });
  const publishedMetadata = npmViewJson(
    `${publishedPackageName}@${publishedVersion}`,
    options.packageRegistryUrl,
  );
  return {
    packageName: "openclaw",
    packageType: "core",
    baseVersion: publishedMetadata?.version?.trim() || null,
    latestVersion: publishedMetadata?.version?.trim() || publishedVersion,
    changed: true,
    publishedInRun: Boolean(publishedMetadata?.version),
    artifactUrl: publishedMetadata?.dist?.tarball?.trim() || null,
    integrity:
      publishedMetadata?.dist?.integrity?.trim() || publishedMetadata?.dist?.shasum?.trim() || null,
    publishedPackageName,
    diffRoots: ["*"],
    source: "github-package-registry",
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
  const publishedVersion = resolvePublishedVersion(options);
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
    const publishedPackageName = resolvePolytroposGithubPublishedPackageName({
      packageName,
      githubScope: requireGithubPackageScope(options),
    });
    const publishedMetadata = publishedVersion
      ? npmViewJson(`${publishedPackageName}@${publishedVersion}`, options.packageRegistryUrl)
      : null;
    return {
      packageName,
      packageType: "plugin",
      baseVersion: publishedMetadata?.version?.trim() || null,
      latestVersion: publishedMetadata?.version?.trim() || publishedVersion,
      changed: selectedPlugins.has(packageName) && changedPackages.has(packageName),
      publishedInRun: Boolean(publishedMetadata?.version),
      artifactUrl: publishedMetadata?.dist?.tarball?.trim() || null,
      integrity:
        publishedMetadata?.dist?.integrity?.trim() ||
        publishedMetadata?.dist?.shasum?.trim() ||
        null,
      publishedPackageName,
      packageDir: candidate.packageDir,
      extensionId: candidate.extensionId,
      diffRoots: [candidate.packageDir],
      source: "github-package-registry",
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
