#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectChangedPathsFromGitRange,
  collectExtensionPackageJsonCandidates,
  parsePluginReleaseSelection,
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
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-polytropos-npm-view-"));
  try {
    const env = { ...process.env };
    if (packageRegistryUrl === GITHUB_PACKAGES_REGISTRY_URL) {
      const token =
        process.env.NODE_AUTH_TOKEN?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        process.env.NPM_TOKEN?.trim() ||
        (() => {
          try {
            return execFileSync("gh", ["auth", "token"], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "ignore"],
            }).trim();
          } catch {
            return "";
          }
        })();
      if (token) {
        const scopeMatch = /^(@[^/]+)\//u.exec(spec.trim());
        const npmrcPath = path.join(stagingDir, ".npmrc");
        const scopeLine = scopeMatch?.[1]
          ? `${scopeMatch[1]}:registry=${packageRegistryUrl}\n`
          : "";
        fs.writeFileSync(
          npmrcPath,
          `${scopeLine}//npm.pkg.github.com/:_authToken=\${NODE_AUTH_TOKEN}\nalways-auth=true\n`,
          { mode: 0o600 },
        );
        env.NODE_AUTH_TOKEN = token;
        env.NPM_CONFIG_USERCONFIG = npmrcPath;
        env.npm_config_userconfig = npmrcPath;
      }
    }
    const raw = execFileSync("npm", ["view", spec, "--json", "--registry", packageRegistryUrl], {
      encoding: "utf8",
      env,
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
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function npmViewVersions(spec: string, packageRegistryUrl: string): string[] {
  try {
    const raw = execFileSync(
      "npm",
      ["view", spec, "versions", "--json", "--registry", packageRegistryUrl],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as string | string[];
    if (typeof parsed === "string") {
      return parsed.trim() ? [parsed.trim()] : [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  } catch {
    return [];
  }
}

function parsePublishedPackageArtifactName(publishedPackageName: string): string {
  const match = publishedPackageName.match(/^@[^/]+\/(.+)$/);
  return match?.[1]?.trim() || publishedPackageName.trim();
}

function ghPackageVersionNames(params: {
  githubPackageScope: string;
  publishedPackageName: string;
}): string[] {
  const owner = params.githubPackageScope.trim();
  const packageName = parsePublishedPackageArtifactName(params.publishedPackageName);
  const endpoints = [
    `/users/${owner}/packages/npm/${packageName}/versions`,
    `/orgs/${owner}/packages/npm/${packageName}/versions`,
  ];

  for (const endpoint of endpoints) {
    try {
      const raw = execFileSync("gh", ["api", endpoint, "--paginate", "--jq", ".[].name"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (!raw) {
        continue;
      }
      return raw
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    } catch {
      continue;
    }
  }

  return [];
}

type PublishedVersionResolution = {
  baseVersion: string | null;
  latestVersion: string | null;
  publishedInRun: boolean;
  artifactUrl: string | null;
  integrity: string | null;
};

export function resolvePublishedVersionState(params: {
  publishedPackageName: string;
  currentReleaseVersion: string;
  packageRegistryUrl: string;
  githubPackageScope: string;
}): PublishedVersionResolution {
  const publishedVersions =
    ghPackageVersionNames({
      githubPackageScope: params.githubPackageScope,
      publishedPackageName: params.publishedPackageName,
    }) || npmViewVersions(params.publishedPackageName, params.packageRegistryUrl);
  const latestVersion = publishedVersions[0] ?? null;
  const publishedInRun = latestVersion === params.currentReleaseVersion;
  const baseVersion = latestVersion
    ? publishedInRun
      ? (publishedVersions[1] ?? null)
      : latestVersion
    : null;
  const resolvedMetadata = latestVersion
    ? npmViewJson(`${params.publishedPackageName}@${latestVersion}`, params.packageRegistryUrl)
    : null;
  return {
    baseVersion,
    latestVersion,
    publishedInRun,
    artifactUrl: resolvedMetadata?.dist?.tarball?.trim() || null,
    integrity:
      resolvedMetadata?.dist?.integrity?.trim() || resolvedMetadata?.dist?.shasum?.trim() || null,
  };
}

export function collectChangedPluginPackageNames(params: {
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
      collectExtensionPackageJsonCandidates(params.rootDir)
        .filter((candidate) => candidate.packageJson.openclaw?.release?.publishToNpm === true)
        .map((candidate) => candidate.packageJson.name?.trim())
        .filter((entry): entry is string => Boolean(entry)),
    );
  }

  const changedExtensionIds = new Set(
    changedPaths.map((entry) => entry.match(/^extensions\/([^/]+)\//)?.[1] ?? "").filter(Boolean),
  );

  return new Set(
    collectExtensionPackageJsonCandidates(params.rootDir)
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
  const publishedVersionState = resolvePublishedVersionState({
    publishedPackageName,
    currentReleaseVersion: publishedVersion,
    packageRegistryUrl: options.packageRegistryUrl,
    githubPackageScope: requireGithubPackageScope(options),
  });
  if (!publishedVersionState.latestVersion) {
    fail(`Could not resolve latest published core package version for ${publishedPackageName}`);
  }
  return {
    packageName: "openclaw",
    packageType: "core",
    baseVersion: publishedVersionState.baseVersion,
    latestVersion: publishedVersionState.latestVersion,
    changed: true,
    publishedInRun: publishedVersionState.publishedInRun,
    artifactUrl: publishedVersionState.artifactUrl,
    integrity: publishedVersionState.integrity,
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
  const candidates = collectExtensionPackageJsonCandidates(rootDir);
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
    const publishedVersionState = resolvePublishedVersionState({
      publishedPackageName,
      currentReleaseVersion: publishedVersion,
      packageRegistryUrl: options.packageRegistryUrl,
      githubPackageScope: requireGithubPackageScope(options),
    });
    if (!publishedVersionState.latestVersion) {
      fail(`Could not resolve latest published plugin package version for ${publishedPackageName}`);
    }
    return {
      packageName,
      packageType: "plugin",
      baseVersion: publishedVersionState.baseVersion,
      latestVersion: publishedVersionState.latestVersion,
      changed: selectedPlugins.has(packageName) && changedPackages.has(packageName),
      publishedInRun: publishedVersionState.publishedInRun,
      artifactUrl: publishedVersionState.artifactUrl,
      integrity: publishedVersionState.integrity,
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
