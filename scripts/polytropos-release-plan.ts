#!/usr/bin/env -S node --import tsx

import fs from "node:fs";
import path from "node:path";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-npm-release.ts";
import { resolvePolytroposGithubPublishedPackageName } from "./lib/polytropos-github-packages.ts";
import { collectChangedPluginPackageNames } from "./polytropos-package-inventory.ts";

type CliOptions = {
  trackedPackagesFile: string;
  outputFile: string;
  githubPackageScope: string;
  baseRef: string | null;
  headRef: string | null;
};

type ReleasePlanEntry = {
  packageName: string;
  packageType: "core" | "plugin";
  publishedPackageName: string;
  shouldPublish: boolean;
  packageDir?: string;
  extensionId?: string;
};

type ReleasePlan = {
  trackedPackagesFile: string;
  packages: ReleasePlanEntry[];
};

function fail(message: string): never {
  throw new Error(message);
}

function parseArgs(argv: string[]): CliOptions {
  let trackedPackagesFile = ".github/polytropos-tracked-packages.json";
  let outputFile = ".local/polytropos-release-plan.json";
  let githubPackageScope = "";
  let baseRef: string | null = null;
  let headRef: string | null = null;

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
      case "--github-package-scope":
        githubPackageScope = next ?? fail("--github-package-scope requires a value");
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
      default:
        fail(`Unknown argument: ${arg}`);
    }
  }

  if (!githubPackageScope.trim()) {
    fail("--github-package-scope is required");
  }
  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    fail("Both --base-ref and --head-ref are required together.");
  }

  return {
    trackedPackagesFile,
    outputFile,
    githubPackageScope,
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

function buildReleasePlan(options: CliOptions): ReleasePlan {
  const trackedPackages = readTrackedPackages(options.trackedPackagesFile);
  if (!trackedPackages.includes("openclaw")) {
    fail('Tracked package file must include "openclaw".');
  }

  const candidates = collectExtensionPackageJsonCandidates(path.resolve("."));
  const candidateByPackageName = new Map(
    candidates
      .map((candidate) => {
        const packageName = candidate.packageJson.name?.trim();
        return packageName ? ([packageName, candidate] as const) : null;
      })
      .filter((entry): entry is readonly [string, (typeof candidates)[number]] => Boolean(entry)),
  );
  const changedPluginPackages =
    options.baseRef && options.headRef
      ? collectChangedPluginPackageNames({
          rootDir: path.resolve("."),
          baseRef: options.baseRef,
          headRef: options.headRef,
        })
      : new Set(trackedPackages.filter((entry) => entry !== "openclaw"));

  const packages = trackedPackages.map((packageName): ReleasePlanEntry => {
    const publishedPackageName = resolvePolytroposGithubPublishedPackageName({
      packageName,
      githubScope: options.githubPackageScope,
    });
    if (packageName === "openclaw") {
      return {
        packageName,
        packageType: "core",
        publishedPackageName,
        shouldPublish: true,
      };
    }
    const candidate = candidateByPackageName.get(packageName);
    if (!candidate) {
      fail(`Tracked plugin package does not resolve to extensions/*/package.json: ${packageName}`);
    }
    return {
      packageName,
      packageType: "plugin",
      publishedPackageName,
      shouldPublish: changedPluginPackages.has(packageName),
      packageDir: candidate.packageDir,
      extensionId: candidate.extensionId,
    };
  });

  return {
    trackedPackagesFile: path.relative(
      path.resolve("."),
      path.resolve(options.trackedPackagesFile),
    ),
    packages,
  };
}

function writePlan(outputFile: string, plan: ReleasePlan) {
  const resolved = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(plan, null, 2) + "\n", "utf8");
}

const options = parseArgs(process.argv.slice(2));
const plan = buildReleasePlan(options);
writePlan(options.outputFile, plan);
console.log(JSON.stringify(plan, null, 2));
