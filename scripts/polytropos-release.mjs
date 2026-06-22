#!/usr/bin/env node
/**
 * Polytropos core release script (single purpose)
 *
 * ONE job:
 *   Create or reuse a release-tag workflow run, download its package inventory,
 *   ensure the inventory's core package is present under ~/polytropos/releases/packages/,
 *   then install that package globally.
 *
 * Notes:
 * - No local builds.
 * - Tags are created and pushed by default; --run-id reuses an existing run and
 *   therefore requires an explicit --tag.
 * - Artifact names must match the release tag (v<ver>-poly.<N>).
 */

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import JSON5 from "json5";
import { buildInstallCommand } from "./lib/polytropos-release-install.mjs";
import {
  ensureStoredReleasePackage,
  resolvePackageReleaseStoreDir,
  resolveStoredReleasePackagePath,
} from "./lib/polytropos-release-package-store.mjs";
import { buildPostInstallPluginSyncCommand } from "./lib/polytropos-release-plugin-sync.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

async function shRetry(logStream, label, fn, { tries = 5, baseDelayMs = 1000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastErr = error;
      const msg = String(error && error.message ? error.message : error);
      // Retry only for known transient install races
      const transient =
        msg.includes("ETXTBSY") || msg.includes("ENOTEMPTY") || msg.includes("EEXIST");
      if (!transient || attempt === tries) {
        throw error;
      }
      const delay = Math.min(8000, baseDelayMs * attempt);
      banner(
        logStream,
        `${label} failed (attempt ${attempt}/${tries}) with transient error; retrying in ${delay}ms`,
      );
      await sleepMs(delay);
    }
  }
  throw lastErr;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function timestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function resolveHome() {
  return process.env.HOME || "/home/ec2-user";
}

function resolveHomePath(input, env = process.env) {
  if (input === "~") {
    return env.HOME || resolveHome();
  }
  if (input.startsWith("~/")) {
    return path.join(env.HOME || resolveHome(), input.slice(2));
  }
  return path.resolve(input);
}

function resolveLiveConfigPath(env = process.env) {
  const explicit = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return resolveHomePath(explicit, env);
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(resolveHomePath(stateDir, env), "openclaw.json");
  }
  const home = env.HOME || resolveHome();
  return path.join(home, ".openclaw", "openclaw.json");
}

function defaultLogPath() {
  const logsDir = path.join(resolveHome(), ".openclaw", "logs", "polytropos-release");
  return path.join(logsDir, `polytropos-release-${timestampForFilename()}.log`);
}

function releasesRoot() {
  return path.join(resolveHome(), "polytropos", "releases");
}

function inventoryPathForTag(relRoot, releaseTag) {
  return path.join(relRoot, `${releaseTag}.json`);
}

function legacyInventoryPathForTag(relRoot, releaseTag) {
  return path.join(relRoot, `${releaseTag}.package-inventory.json`);
}

function resolveExistingInventoryPathForTag(relRoot, releaseTag) {
  const inventoryPath = inventoryPathForTag(relRoot, releaseTag);
  if (fs.existsSync(inventoryPath)) {
    return inventoryPath;
  }
  const legacyInventoryPath = legacyInventoryPathForTag(relRoot, releaseTag);
  if (fs.existsSync(legacyInventoryPath)) {
    return legacyInventoryPath;
  }
  return inventoryPath;
}

function releasePackagePathForTag(relRoot, releaseTag) {
  return resolveStoredReleasePackagePath(relRoot, {
    packageName: "openclaw",
    version: releaseTag.replace(/^v/, ""),
  });
}

function inventoryArtifactNameForTag(releaseTag) {
  return `polytropos-package-inventory-${releaseTag}`;
}

function tgzInternalVersion(tgzPath) {
  let raw;
  try {
    raw = execFileSync("tar", ["-xOzf", tgzPath, "package/package.json"], {
      encoding: "utf8",
    });
  } catch (error) {
    raw = typeof error?.stdout === "string" && error.stdout.trim() ? error.stdout : null;
    if (!raw) {
      throw error;
    }
  }
  const obj = JSON.parse(raw);
  return { name: obj?.name, version: obj?.version };
}

function isPolytroposCorePackageName(packageName) {
  return packageName === "openclaw" || packageName.endsWith("/openclaw-polytropos-core");
}

function installedPackageRoot(npmRoot, packageName) {
  return path.join(npmRoot, ...String(packageName).split("/"));
}

function installedCorePackageRoots(npmRoot, packageName) {
  return [
    installedPackageRoot(npmRoot, packageName),
    installedPackageRoot(npmRoot, "openclaw"),
  ].filter((entry, index, all) => all.indexOf(entry) === index);
}

function readReleaseInventory(inventoryPath) {
  const parsed = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
  if (!parsed || !Array.isArray(parsed.packages)) {
    throw new Error(`release inventory must contain a packages array: ${inventoryPath}`);
  }
  return parsed;
}

function releaseTagFromInventoryPath(inventoryPath) {
  const baseName = path.basename(inventoryPath);
  const match = /^(v.+(?:\+|-)poly\.\d+)(?:\.package-inventory)?\.json$/u.exec(baseName);
  return match?.[1] ?? null;
}

function resolveCoreInventoryEntry(inventory, inventoryPath) {
  const entry = inventory.packages.find(
    (candidate) =>
      candidate?.packageType === "core" &&
      candidate?.packageName === "openclaw" &&
      typeof candidate?.latestVersion === "string" &&
      candidate.latestVersion.trim(),
  );
  if (!entry) {
    throw new Error(`release inventory is missing core package metadata: ${inventoryPath}`);
  }
  return entry;
}

function stripPolySuffix(version) {
  return String(version).replace(/(?:\+|-)?poly\.\d+$/u, "");
}

function assertStoredCorePackageConsistent({ fileName, fullPath, info }) {
  const currentNameMatch = /^openclaw-(.+)\.tgz$/u.exec(fileName);
  const legacyNameMatch = currentNameMatch
    ? null
    : /^v(.+?)(?:(?:\+|-)?poly\.\d+)?\.tgz$/u.exec(fileName);
  const expectedVersion = currentNameMatch?.[1] ?? legacyNameMatch?.[1] ?? null;
  if (!expectedVersion) {
    return;
  }
  if (!isPolytroposCorePackageName(info.name)) {
    throw new Error(`release store corruption: ${fileName} package name ${info.name}`);
  }
  const allowedVersions = currentNameMatch
    ? new Set([expectedVersion])
    : new Set([expectedVersion, stripPolySuffix(expectedVersion)]);
  if (!allowedVersions.has(info.version)) {
    throw new Error(
      `release store corruption: ${fullPath} contains version ${info.version} (expected ${expectedVersion})`,
    );
  }
}

function assertCorePackageMatchesExpected({ packagePath, expectedVersion, contextLabel }) {
  const info = tgzInternalVersion(packagePath);
  if (!isPolytroposCorePackageName(info.name)) {
    throw new Error(`${contextLabel} has unexpected package name ${info.name}`);
  }
  if (info.version !== expectedVersion) {
    throw new Error(
      `${contextLabel} contains version ${info.version} (expected ${expectedVersion})`,
    );
  }
  return info;
}

export function assertReleaseStoreConsistent(relRoot) {
  if (!fs.existsSync(relRoot)) {
    return;
  }
  const packageRoot = resolvePackageReleaseStoreDir(relRoot);
  if (!fs.existsSync(packageRoot)) {
    return;
  }
  const entries = fs.readdirSync(packageRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) {
      continue;
    }
    if (!e.name.endsWith(".tgz")) {
      continue;
    }
    const full = path.join(packageRoot, e.name);
    const info = tgzInternalVersion(full);
    if (!info.name || !info.version) {
      throw new Error(`release store corruption: ${full} is missing package name or version`);
    }
    assertStoredCorePackageConsistent({ fileName: e.name, fullPath: full, info });
  }
}

function getGlobalPrefix() {
  // Prefer explicit npm prefix; else default to ~/.npm-global used by the gateway service.
  const p = process.env.OPENCLAW_GLOBAL_PREFIX;
  if (p) {
    return p;
  }
  return path.join(resolveHome(), ".npm-global");
}

function teeWriteStream(logStream, chunk) {
  try {
    logStream.write(chunk);
  } catch {}
}

async function shTee(logStream, cmd, args, opts = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      teeWriteStream(logStream, chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      teeWriteStream(logStream, chunk);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `command failed: ${cmd} ${args.join(" ")} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          ),
        );
      }
    });
  });
}

function commandString(cmd, args) {
  return [cmd, ...args].join(" ");
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function findRunIdForTag({ logStream, ghRepo, wf, releaseTag, timeoutMs = 180000 }) {
  const started = Date.now();
  let attempt = 0;
  while (Date.now() - started < timeoutMs) {
    attempt++;
    let runId = "";
    try {
      runId = sh("gh", [
        "run",
        "list",
        "--repo",
        ghRepo,
        "--workflow",
        wf,
        "--event",
        "push",
        "--limit",
        "20",
        "--json",
        "databaseId,headBranch",
        "--jq",
        // Only accept the tag push run (headBranch==releaseTag); otherwise return empty and retry
        `.[] | select(.headBranch=="${releaseTag}") | .databaseId`,
      ]);
    } catch {
      // ignore and retry
    }
    if (runId) {
      banner(logStream, `Found run id: ${runId}`);
      return runId;
    }
    const delay = Math.min(15000, 2000 + attempt * 1000);
    banner(logStream, `Run not visible yet (attempt ${attempt}); retrying in ${delay}ms`);
    await sleepMs(delay);
  }
  fail(`could not find workflow run for tag ${releaseTag} within ${timeoutMs}ms`);
  throw new Error(`could not find workflow run for tag ${releaseTag} within ${timeoutMs}ms`);
}

function addReleaseArtifactCandidate(candidates, name, prefix, field) {
  if (!name.startsWith(prefix)) {
    return;
  }
  const releaseTag = name.slice(prefix.length);
  if (!/^v.+-poly\.\d+$/.test(releaseTag)) {
    return;
  }
  const candidate = candidates.get(releaseTag) ?? {};
  candidate[field] = name;
  candidates.set(releaseTag, candidate);
}

export function resolvePolytroposReleaseArtifacts({ requestedTag, artifacts }) {
  const available = artifacts
    .filter((artifact) => artifact?.expired !== true && typeof artifact?.name === "string")
    .map((artifact) => artifact.name);

  const candidates = new Map();
  for (const name of available) {
    addReleaseArtifactCandidate(candidates, name, "openclaw-tgz-", "tgzArtifact");
    addReleaseArtifactCandidate(
      candidates,
      name,
      "polytropos-package-inventory-",
      "inventoryArtifact",
    );
  }

  const requested = candidates.get(requestedTag);
  if (requested?.inventoryArtifact) {
    return {
      releaseTag: requestedTag,
      ...(requested.tgzArtifact ? { tgzArtifact: requested.tgzArtifact } : {}),
      inventoryArtifact: requested.inventoryArtifact,
    };
  }

  const complete = [...candidates.entries()].filter(([, candidate]) => candidate.inventoryArtifact);
  if (complete.length === 1) {
    const [releaseTag, candidate] = complete[0];
    return {
      releaseTag,
      ...(candidate.tgzArtifact ? { tgzArtifact: candidate.tgzArtifact } : {}),
      inventoryArtifact: candidate.inventoryArtifact,
    };
  }

  const availableList =
    available.length > 0 ? available.map((name) => `- ${name}`).join("\n") : "- <none>";
  throw new Error(
    `could not resolve release artifacts for ${requestedTag}. Expected ${inventoryArtifactNameForTag(
      requestedTag,
    )}, or exactly one complete polytropos-package-inventory- tag artifact.\nAvailable artifacts:\n${availableList}`,
  );
}

function listRunArtifacts({ ghRepo, runId }) {
  const raw = sh("gh", ["api", `repos/${ghRepo}/actions/runs/${runId}/artifacts?per_page=100`]);
  const parsed = JSON.parse(raw);
  const artifacts = Array.isArray(parsed?.artifacts) ? parsed.artifacts : [];
  return artifacts.map((artifact) => ({
    name: artifact?.name,
    expired: artifact?.expired,
  }));
}

function banner(logStream, s) {
  const line = `\n==> ${s}\n`;
  process.stdout.write(line);
  teeWriteStream(logStream, line);
}

function inferGhRepoFromOrigin() {
  // Supports: git@github.com:owner/repo.git OR https://github.com/owner/repo.git
  const url = sh("git", ["remote", "get-url", "origin"]);
  const m1 = url.match(/github\.com[:/](.+?)\.git$/);
  if (m1) {
    return m1[1];
  }
  const m2 = url.match(/github\.com[:/](.+?)$/);
  if (m2) {
    return m2[1];
  }
  fail(`could not infer GitHub repo from origin url: ${url}`);
  throw new Error(`could not infer GitHub repo from origin url: ${url}`);
}

function computeNextReleaseTag() {
  // base version comes from package.json
  const ver = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  // next poly is global max + 1 across both old +poly and new -poly formats
  const tags = sh("git", ["tag", "-l", "v*poly.*"]);
  let maxN = -1;
  for (const line of tags.split(/\r?\n/)) {
    const m = line.match(/(?:\+|-)poly\.(\d+)$/);
    if (!m) {
      continue;
    }
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxN) {
      maxN = n;
    }
  }
  const nextN = maxN + 1;
  return `v${ver}-poly.${nextN}`;
}

function parseReleaseTagPolyNumber(tag) {
  const match = /^v.+(?:\+|-)poly\.(\d+)$/.exec(tag);
  return match ? Number(match[1]) : null;
}

function findPreviousReleaseTag(currentTag) {
  const currentPoly = parseReleaseTagPolyNumber(currentTag);
  if (!Number.isFinite(currentPoly)) {
    return null;
  }
  const tags = sh("git", ["tag", "-l", "v*poly.*"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let best = null;
  let bestPoly = -1;
  for (const tag of tags) {
    const poly = parseReleaseTagPolyNumber(tag);
    if (!Number.isFinite(poly) || poly >= currentPoly || poly <= bestPoly) {
      continue;
    }
    best = tag;
    bestPoly = poly;
  }
  return best;
}

export function parseArgs(argv) {
  // Supported:
  //   node scripts/polytropos-release.mjs release [--tag v<ver>-poly.<N>] [--run-id <id>] [--rerun-run] [--repo <owner/repo>] [--workflow <workflow.yml>] [--log <path>]
  //   node scripts/polytropos-release.mjs install <tgz-or-inventory-json> [--log <path>] [--plugin-sync-config auto|normal|sanitized-temp]
  const args = argv.slice(2);
  const cmd = args[0] || "";
  let logPath = process.env.POLYTROPOS_RELEASE_LOG || defaultLogPath();
  let repo = null;
  let workflow = null;
  let releaseTag = null;
  let runId = null;
  let rerunRun = false;
  let installTgz = null;
  let baseRef = null;
  let headRef = null;
  let pluginSyncConfig = "auto";

  if (cmd === "install") {
    installTgz = args[1] || null;
    if (!installTgz) {
      fail("install requires <tgz-or-inventory-json>");
    }
  }

  for (let i = cmd === "install" ? 2 : 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--log") {
      const v = args[i + 1];
      if (!v) {
        fail("--log requires a path");
      }
      logPath = v;
      i++;
      continue;
    }
    if (a === "--repo") {
      const v = args[i + 1];
      if (!v) {
        fail("--repo requires owner/repo");
      }
      repo = v;
      i++;
      continue;
    }
    if (a === "--workflow") {
      const v = args[i + 1];
      if (!v) {
        fail("--workflow requires a filename (e.g. polytropos-build-pack.yml)");
      }
      workflow = v;
      i++;
      continue;
    }
    if (a === "--tag") {
      const v = args[i + 1];
      if (!v) {
        fail("--tag requires v<ver>-poly.<N>");
      }
      releaseTag = v;
      i++;
      continue;
    }
    if (a === "--run-id") {
      const v = args[i + 1];
      if (!v) {
        fail("--run-id requires a GitHub Actions run id");
      }
      runId = v;
      i++;
      continue;
    }
    if (a === "--rerun-run") {
      rerunRun = true;
      continue;
    }
    if (a === "--base-ref") {
      const v = args[i + 1];
      if (!v) {
        fail("--base-ref requires a git ref");
      }
      baseRef = v;
      i++;
      continue;
    }
    if (a === "--head-ref") {
      const v = args[i + 1];
      if (!v) {
        fail("--head-ref requires a git ref");
      }
      headRef = v;
      i++;
      continue;
    }
    if (a === "--plugin-sync-config") {
      const v = args[i + 1];
      if (!["auto", "normal", "sanitized-temp"].includes(v)) {
        fail("--plugin-sync-config requires auto, normal, or sanitized-temp");
      }
      pluginSyncConfig = v;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return {
        cmd: "--help",
        logPath,
        repo,
        workflow,
        releaseTag,
        runId,
        rerunRun,
        installTgz,
        baseRef,
        headRef,
        pluginSyncConfig,
      };
    }
    fail(`unknown argument: ${a}`);
  }

  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    fail("install requires both --base-ref and --head-ref together");
  }
  if (runId && !releaseTag) {
    fail("release with --run-id requires --tag so artifact names stay explicit");
  }
  if (rerunRun && !runId) {
    fail("--rerun-run requires --run-id");
  }

  return {
    cmd,
    logPath,
    repo,
    workflow,
    releaseTag,
    runId,
    rerunRun,
    installTgz,
    baseRef,
    headRef,
    pluginSyncConfig,
  };
}

function usage() {
  console.log(`polytropos-release.mjs

Usage:
  node scripts/polytropos-release.mjs release [--tag v<ver>-poly.<N>] [--run-id <id> [--rerun-run]] [--repo <owner/repo>] [--workflow <workflow.yml>] [--log <path>]
  node scripts/polytropos-release.mjs install <tgz-or-inventory-json> [--base-ref <ref> --head-ref <ref>] [--plugin-sync-config auto|normal|sanitized-temp] [--log <path>]

Behavior (single flow):
  - Pushes the release tag to GitHub, unless --run-id reuses an existing tag run
  - Waits for the GitHub Actions workflow run for that tag to complete
  - Downloads artifact polytropos-package-inventory-<tag>
  - Stages it into ~/polytropos/releases/<tag>.json
  - Ensures the inventory core package archive exists in ~/polytropos/releases/packages/
  - Calls install with that package archive to perform the final install steps
  - install <tgz-or-inventory-json> performs the global install, bundled deps helper, and managed plugin sync
  - plugin sync normally uses the live config; --plugin-sync-config sanitized-temp bypasses
    config validation with a temporary copy of the live config minus session.reset, and auto
    retries that way after failure
  - Does not activate/restart the gateway
`);
}

export function createSanitizedTemporaryConfigPath(env = process.env) {
  const liveConfigPath = resolveLiveConfigPath(env);
  if (!fs.existsSync(liveConfigPath)) {
    throw new Error(`live OpenClaw config not found for sanitized fallback: ${liveConfigPath}`);
  }
  const raw = fs.readFileSync(liveConfigPath, "utf8");
  const parsed = JSON5.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`live OpenClaw config must be an object: ${liveConfigPath}`);
  }
  const sanitized = structuredClone(parsed);
  if (
    sanitized.session &&
    typeof sanitized.session === "object" &&
    !Array.isArray(sanitized.session)
  ) {
    delete sanitized.session.reset;
  }
  const configDir = path.dirname(liveConfigPath);
  const configPath = path.join(
    configDir,
    `openclaw.polytropos-release-sanitized-${timestampForFilename()}-${process.pid}-${randomUUID()}.json`,
  );
  fs.writeFileSync(configPath, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

export function stageDownloadedReleaseTarball({
  logStream,
  downloadedTgzPath,
  relRoot,
  releaseTag,
  expectedVersion,
}) {
  const tarPath = releasePackagePathForTag(relRoot, releaseTag);
  if (fs.existsSync(tarPath)) {
    const info = tgzInternalVersion(tarPath);
    if (!isPolytroposCorePackageName(info.name)) {
      fail(`release store corruption: ${releaseTag}.tgz package name ${info.name}`);
    }
    if (info.version !== expectedVersion) {
      fail(
        `release store corruption: ${releaseTag}.tgz contains version ${info.version} (expected ${expectedVersion})`,
      );
    }
    banner(logStream, `Reusing already-staged release tarball: ${tarPath}`);
    return tarPath;
  }
  fs.mkdirSync(path.dirname(tarPath), { recursive: true });
  const tempPath = `${tarPath}.tmp-${process.pid}-${randomUUID()}`;
  fs.copyFileSync(downloadedTgzPath, tempPath);
  const info = tgzInternalVersion(tempPath);
  if (!isPolytroposCorePackageName(info.name)) {
    fs.rmSync(tempPath, { force: true });
    fail(`unexpected package name in staged tgz: ${info.name}`);
  }
  if (info.version !== expectedVersion) {
    fs.rmSync(tempPath, { force: true });
    fail(`staged tgz version ${info.version} != expected ${expectedVersion} (from ${releaseTag})`);
  }
  fs.renameSync(tempPath, tarPath);
  return tarPath;
}

export function resolveReleaseCoreInstallPackagePath({ relRoot, releaseTag }) {
  const inventoryPath = resolveExistingInventoryPathForTag(relRoot, releaseTag);
  if (!fs.existsSync(inventoryPath)) {
    throw new Error(`release inventory not found: ${inventoryPath}`);
  }
  const coreEntry = resolveCoreInventoryEntry(readReleaseInventory(inventoryPath), inventoryPath);
  const packagePath = resolveStoredReleasePackagePath(relRoot, {
    packageName: coreEntry.packageName,
    version: coreEntry.latestVersion,
  });
  if (!fs.existsSync(packagePath)) {
    throw new Error(`required core package is not in the release package store: ${packagePath}`);
  }
  assertCorePackageMatchesExpected({
    packagePath,
    expectedVersion: coreEntry.latestVersion,
    contextLabel: `stored core package ${packagePath}`,
  });
  return packagePath;
}

export function resolveInstallPackageInput(inputPath) {
  const resolvedInputPath = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`install package input does not exist: ${resolvedInputPath}`);
  }
  if (path.extname(resolvedInputPath) !== ".json") {
    return { packagePath: resolvedInputPath, releaseTag: null, inventoryPath: null };
  }

  const inventory = readReleaseInventory(resolvedInputPath);
  const releaseTag =
    typeof inventory.releaseTag === "string" && inventory.releaseTag.trim()
      ? inventory.releaseTag.trim()
      : releaseTagFromInventoryPath(resolvedInputPath);
  if (!releaseTag) {
    throw new Error(`could not infer release tag from inventory: ${resolvedInputPath}`);
  }
  const coreEntry = resolveCoreInventoryEntry(inventory, resolvedInputPath);
  const relRoot = path.dirname(resolvedInputPath);
  const packagePath = resolveStoredReleasePackagePath(relRoot, {
    packageName: coreEntry.packageName,
    version: coreEntry.latestVersion,
  });
  if (!fs.existsSync(packagePath)) {
    throw new Error(`required core package is not in the release package store: ${packagePath}`);
  }
  assertCorePackageMatchesExpected({
    packagePath,
    expectedVersion: coreEntry.latestVersion,
    contextLabel: `stored core package ${packagePath}`,
  });
  return { packagePath, releaseTag, inventoryPath: resolvedInputPath };
}

export async function prepareInstallPackageInput(
  inputPath,
  { env = process.env, ensureStoredReleasePackageImpl = ensureStoredReleasePackage, logger } = {},
) {
  const resolvedInputPath = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`install package input does not exist: ${resolvedInputPath}`);
  }
  if (path.extname(resolvedInputPath) !== ".json") {
    return { packagePath: resolvedInputPath, releaseTag: null, inventoryPath: null };
  }

  const inventory = readReleaseInventory(resolvedInputPath);
  const releaseTag =
    typeof inventory.releaseTag === "string" && inventory.releaseTag.trim()
      ? inventory.releaseTag.trim()
      : releaseTagFromInventoryPath(resolvedInputPath);
  if (!releaseTag) {
    throw new Error(`could not infer release tag from inventory: ${resolvedInputPath}`);
  }
  const coreEntry = resolveCoreInventoryEntry(inventory, resolvedInputPath);
  const relRoot = path.dirname(resolvedInputPath);
  let packagePath = resolveStoredReleasePackagePath(relRoot, {
    packageName: coreEntry.packageName,
    version: coreEntry.latestVersion,
  });
  if (!fs.existsSync(packagePath)) {
    packagePath = await ensureStoredReleasePackageImpl({
      relRoot,
      packageName: coreEntry.packageName,
      registryPackageName: coreEntry.publishedPackageName,
      version: coreEntry.latestVersion,
      artifactUrl: coreEntry.artifactUrl,
      logger,
      env,
    });
  }
  assertCorePackageMatchesExpected({
    packagePath,
    expectedVersion: coreEntry.latestVersion,
    contextLabel: `stored core package ${packagePath}`,
  });
  return { packagePath, releaseTag, inventoryPath: resolvedInputPath };
}

function moveAsideIfExists(logStream, targetPath, label) {
  if (!fs.existsSync(targetPath) && !fs.existsSync(path.dirname(targetPath))) {
    return null;
  }
  try {
    fs.lstatSync(targetPath);
  } catch {
    return null;
  }
  const bak = `${targetPath}.bak-${timestampForFilename()}`;
  banner(logStream, `Moving aside existing ${label}: ${targetPath} -> ${bak}`);
  fs.renameSync(targetPath, bak);
  return bak;
}

function restoreMovedAsidePath(logStream, { targetPath, backupPath, label }) {
  if (!backupPath || !fs.existsSync(backupPath)) {
    return;
  }
  if (fs.existsSync(targetPath)) {
    const failedPath = `${targetPath}.failed-${timestampForFilename()}-${process.pid}-${randomUUID()}`;
    banner(logStream, `Moving aside failed ${label}: ${targetPath} -> ${failedPath}`);
    fs.renameSync(targetPath, failedPath);
  }
  banner(logStream, `Restoring previous ${label}: ${backupPath} -> ${targetPath}`);
  fs.renameSync(backupPath, targetPath);
}

function updateReleasePointers({ logStream, relRoot, packagePath }) {
  const currentPath = path.join(relRoot, "current.tgz");
  const previousPath = path.join(relRoot, "previous.tgz");
  const tempCurrentPath = `${currentPath}.tmp-${process.pid}-${randomUUID()}`;
  const tempPreviousPath = `${previousPath}.tmp-${process.pid}-${randomUUID()}`;
  const currentMatchesPackage =
    fs.existsSync(currentPath) &&
    fs.statSync(currentPath).size === fs.statSync(packagePath).size &&
    fs.readFileSync(currentPath).equals(fs.readFileSync(packagePath));

  try {
    if (fs.existsSync(currentPath) && !currentMatchesPackage) {
      fs.copyFileSync(currentPath, tempPreviousPath);
      fs.renameSync(tempPreviousPath, previousPath);
    }
    fs.copyFileSync(packagePath, tempCurrentPath);
    fs.renameSync(tempCurrentPath, currentPath);
  } finally {
    fs.rmSync(tempCurrentPath, { force: true });
    fs.rmSync(tempPreviousPath, { force: true });
  }
  banner(logStream, `Updated release package pointers: ${currentPath}, ${previousPath}`);
}

async function runPostInstallPluginSync({ logStream, pluginSyncCommand, pluginSyncConfig }) {
  const runSync = async (label, env = process.env) => {
    await shRetry(logStream, label, async () => {
      await shTee(logStream, pluginSyncCommand.cmd, pluginSyncCommand.args, {
        cwd: pluginSyncCommand.cwd,
        env,
      });
    });
  };

  const runWithSanitizedConfig = async (bannerMessage) => {
    const configPath = createSanitizedTemporaryConfigPath();
    banner(logStream, `${bannerMessage}: ${configPath}`);
    try {
      await runSync("release plugin sync (sanitized config)", {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
      });
    } finally {
      fs.rmSync(configPath, { force: true });
    }
  };

  if (pluginSyncConfig === "sanitized-temp") {
    await runWithSanitizedConfig(
      "Using sanitized temporary config with session.reset removed for release plugin sync",
    );
    return;
  }

  try {
    await runSync("release plugin sync");
  } catch (error) {
    if (pluginSyncConfig !== "auto") {
      throw error;
    }
    teeWriteStream(logStream, `${String(error?.message ?? error)}\n`);
    await runWithSanitizedConfig(
      "Release plugin sync failed with live config; retrying with sanitized temporary config that removes session.reset",
    );
  }
}

async function runInstall({ logStream, tgzPath, baseRef, headRef, pluginSyncConfig }) {
  let installInput;
  try {
    installInput = await prepareInstallPackageInput(tgzPath, {
      logger: {
        info: (message) => banner(logStream, message),
        warn: (message) => banner(logStream, message),
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const resolvedTgzPath = installInput.packagePath;
  const info = tgzInternalVersion(resolvedTgzPath);
  if (!isPolytroposCorePackageName(info.name)) {
    fail(`unexpected package name in install tgz: ${info.name}`);
  }
  const effectiveHeadRef = headRef ?? installInput.releaseTag ?? null;
  const effectiveBaseRef =
    baseRef ?? (effectiveHeadRef ? findPreviousReleaseTag(effectiveHeadRef) : null);
  banner(logStream, `Installing tgz ${resolvedTgzPath} (version ${info.version})`);

  const prefix = getGlobalPrefix();
  banner(logStream, `Installing globally into prefix: ${prefix}`);
  const rollbackEntries = [];
  {
    const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
    for (const installedRoot of installedCorePackageRoots(npmRoot, info.name)) {
      const backupPath = moveAsideIfExists(logStream, installedRoot, "global install");
      if (backupPath) {
        rollbackEntries.push({
          targetPath: installedRoot,
          backupPath,
          label: "global install",
        });
      }
    }
    const binPath = path.join(prefix, "bin", "openclaw");
    const binBackupPath = moveAsideIfExists(logStream, binPath, "global bin shim");
    if (binBackupPath) {
      rollbackEntries.push({
        targetPath: binPath,
        backupPath: binBackupPath,
        label: "global bin shim",
      });
    }
  }

  try {
    await shRetry(logStream, "npm install -g", async () => {
      await shTee(logStream, "npm", ["install", "-g", "--prefix", prefix, resolvedTgzPath]);
    });

    banner(logStream, "Running Polytropos bundled plugin deps helper...");
    {
      const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
      const installedRoot = installedPackageRoot(npmRoot, info.name);
      const helperPath = path.join(
        installedRoot,
        "scripts",
        "polytropos-bundled-plugin-deps-helper.mjs",
      );
      if (!fs.existsSync(helperPath)) {
        throw new Error(`Polytropos helper not found at ${helperPath}`);
      }
      await shRetry(logStream, "bundled deps helper", async () => {
        await shTee(logStream, "node", [helperPath]);
      });
      banner(logStream, "Bundled plugin deps helper completed.");

      banner(logStream, "Syncing release-updated installed plugins...");
      const pluginSyncCommand = buildPostInstallPluginSyncCommand({
        repoRoot: REPO_ROOT,
        installedRoot,
        baseRef: effectiveBaseRef ?? undefined,
        headRef: effectiveHeadRef ?? undefined,
      });
      await runPostInstallPluginSync({
        logStream,
        pluginSyncCommand,
        pluginSyncConfig,
      });
      banner(logStream, "Release plugin sync completed.");
    }
  } catch (error) {
    banner(logStream, `Install failed; attempting rollback: ${String(error?.message ?? error)}`);
    for (const entry of rollbackEntries.toReversed()) {
      restoreMovedAsidePath(logStream, entry);
    }
    throw error;
  }

  updateReleasePointers({
    logStream,
    relRoot: releasesRoot(),
    packagePath: resolvedTgzPath,
  });
  banner(logStream, "Activation required: restart the gateway to run the new code");
  banner(logStream, `Install completed for version ${info.version} (not activated).`);
}

async function main(argv = process.argv) {
  const {
    cmd,
    logPath,
    repo,
    workflow,
    releaseTag: requestedTag,
    runId: requestedRunId,
    rerunRun,
    installTgz,
    baseRef,
    headRef,
    pluginSyncConfig,
  } = parseArgs(argv);
  if (!cmd || cmd === "--help") {
    usage();
    process.exit(0);
  }

  if (cmd !== "release" && cmd !== "install") {
    fail(`unknown command: ${cmd}`);
  }

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  banner(logStream, `Log file: ${logPath}`);

  try {
    if (cmd === "install") {
      await runInstall({ logStream, tgzPath: installTgz, baseRef, headRef, pluginSyncConfig });
    } else {
      let releaseTag = requestedTag ?? computeNextReleaseTag();
      if (!/^v.+-poly\.\d+$/.test(releaseTag)) {
        fail(`invalid --tag: ${releaseTag} (expected v<ver>-poly.<N>)`);
      }

      const ghRepo = repo || inferGhRepoFromOrigin();
      const wf = workflow || "polytropos-build-pack.yml";

      banner(logStream, `GitHub repo: ${ghRepo}`);
      banner(logStream, `Workflow: ${wf}`);
      banner(logStream, `Release tag: ${releaseTag}`);
      let previousReleaseTag = findPreviousReleaseTag(releaseTag);
      if (previousReleaseTag) {
        banner(logStream, `Previous release tag: ${previousReleaseTag}`);
      } else {
        banner(logStream, "Previous release tag: none");
      }

      if (requestedRunId) {
        banner(
          logStream,
          `Reusing existing workflow run ${requestedRunId} for ${releaseTag}; tag creation and push skipped`,
        );
      } else {
        const releaseBranch = assertValidReleaseBranch();
        banner(logStream, `Release branch: ${releaseBranch}`);
      }

      const relRoot = releasesRoot();
      fs.mkdirSync(relRoot, { recursive: true });
      fs.mkdirSync(resolvePackageReleaseStoreDir(relRoot), { recursive: true });
      assertReleaseStoreConsistent(relRoot);

      let runId = requestedRunId;
      if (!runId) {
        try {
          sh("git", ["rev-parse", "--verify", `refs/tags/${releaseTag}`]);
        } catch {
          banner(logStream, `Creating tag locally: ${releaseTag}`);
          await shTee(logStream, "git", [
            "tag",
            "-a",
            releaseTag,
            "-m",
            `Polytropos release ${releaseTag}`,
          ]);
        }

        banner(logStream, `Pushing tag: ${releaseTag}`);
        await shTee(logStream, "git", ["push", "origin", releaseTag]);

        banner(logStream, "Locating workflow run...");
        runId = await findRunIdForTag({ logStream, ghRepo, wf, releaseTag });
      }

      if (rerunRun) {
        banner(logStream, `Rerunning existing workflow run: ${runId}`);
        await shTee(logStream, "gh", ["run", "rerun", runId, "--repo", ghRepo]);
      }

      banner(logStream, `Watching run: ${runId}`);
      await shTee(logStream, "gh", ["run", "watch", runId, "--repo", ghRepo, "--exit-status"]);

      let resolvedArtifacts;
      try {
        resolvedArtifacts = resolvePolytroposReleaseArtifacts({
          requestedTag: releaseTag,
          artifacts: listRunArtifacts({ ghRepo, runId }),
        });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
      if (resolvedArtifacts.releaseTag !== releaseTag) {
        banner(
          logStream,
          `Resolved release tag from run artifacts: ${releaseTag} -> ${resolvedArtifacts.releaseTag}`,
        );
        releaseTag = resolvedArtifacts.releaseTag;
        previousReleaseTag = findPreviousReleaseTag(releaseTag);
        if (previousReleaseTag) {
          banner(logStream, `Previous release tag: ${previousReleaseTag}`);
        } else {
          banner(logStream, "Previous release tag: none");
        }
      }

      const inventoryArtifact = resolvedArtifacts.inventoryArtifact;
      const inventoryPath = inventoryPathForTag(relRoot, releaseTag);
      if (!fs.existsSync(inventoryPath)) {
        const tmpDir = fs.mkdtempSync(path.join(resolveHome(), ".openclaw", "tmp-release-"));

        banner(logStream, `Downloading artifact ${inventoryArtifact} to ${tmpDir}`);
        await shTee(logStream, "gh", [
          "run",
          "download",
          runId,
          "--repo",
          ghRepo,
          "-n",
          inventoryArtifact,
          "--dir",
          tmpDir,
        ]);

        const foundInventory = path.join(tmpDir, "polytropos-package-inventory.json");
        if (!fs.existsSync(foundInventory)) {
          fail(`expected downloaded inventory artifact at ${foundInventory}`);
        }
        fs.copyFileSync(foundInventory, inventoryPath);
      } else {
        banner(
          logStream,
          `Reusing staged package inventory from local release store: ${inventoryPath}`,
        );
      }

      const coreEntry = resolveCoreInventoryEntry(
        readReleaseInventory(inventoryPath),
        inventoryPath,
      );
      const tarPath = await ensureStoredReleasePackage({
        relRoot,
        packageName: coreEntry.packageName,
        registryPackageName: coreEntry.publishedPackageName,
        version: coreEntry.latestVersion,
        artifactUrl: coreEntry.artifactUrl,
        logger: {
          info: (message) => banner(logStream, message),
          warn: (message) => banner(logStream, message),
        },
      });
      const info = tgzInternalVersion(tarPath);
      if (!isPolytroposCorePackageName(info.name)) {
        fail(`unexpected package name in staged core package: ${info.name}`);
      }
      if (info.version !== coreEntry.latestVersion) {
        fail(
          `staged core package version ${info.version} != inventory version ${coreEntry.latestVersion}`,
        );
      }

      banner(logStream, `Staged core package: ${tarPath}`);
      banner(logStream, `Staged package inventory: ${inventoryPath}`);
      banner(logStream, `Delegating install for inventory core package ${tarPath}`);
      const installCommand = buildInstallCommand({
        repoRoot: REPO_ROOT,
        tgzPath: tarPath,
        baseRef: previousReleaseTag ?? undefined,
        headRef: releaseTag,
        logPath,
        pluginSyncConfig,
      });
      banner(
        logStream,
        `Install command: ${commandString(installCommand.cmd, installCommand.args)}`,
      );
      await shTee(logStream, installCommand.cmd, installCommand.args);
      banner(logStream, "Release staged and install delegated (not activated).");
    }
  } finally {
    logStream.end();
  }
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryUrl) {
  await main();
}
function currentBranchName() {
  return sh("git", ["branch", "--show-current"]);
}

function assertValidReleaseBranch() {
  const branch = currentBranchName();
  if (!/^release\/\d{4}\.\d{1,2}\.\d{1,2}$/.test(branch)) {
    fail(
      `release script must run from a valid release branch (release/YYYY.M.D (matching the version/tag format)); current branch: ${branch}`,
    );
  }
  return branch;
}
