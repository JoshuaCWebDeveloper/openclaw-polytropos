#!/usr/bin/env node
/**
 * Polytropos core release script (single purpose)
 *
 * ONE job:
 *   Download a CI-built release artifact from GitHub Actions and stage it into the
 *   authoritative local release store under ~/polytropos/releases/, then install it globally.
 *
 * Notes:
 * - No local builds.
 * - No git tagging.
 * - Artifact naming is the source of truth for the release tag (v<ver>-poly.<N>).
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstallCommand } from "./lib/polytropos-release-install.mjs";
import { buildPostInstallPluginSyncCommand } from "./lib/polytropos-release-plugin-sync.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

async function shRetry(logStream, label, fn, { tries = 5, baseDelayMs = 1000 } = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message ? e.message : e);
      // Retry only for known transient install races
      const transient =
        msg.includes("ETXTBSY") || msg.includes("ENOTEMPTY") || msg.includes("EEXIST");
      if (!transient || attempt == tries) throw e;
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

function defaultLogPath() {
  const logsDir = path.join(resolveHome(), ".openclaw", "logs", "polytropos-release");
  return path.join(logsDir, `polytropos-release-${timestampForFilename()}.log`);
}

function releasesRoot() {
  return path.join(resolveHome(), "polytropos", "releases");
}

function inventoryPathForTag(relRoot, releaseTag) {
  return path.join(relRoot, `${releaseTag}.package-inventory.json`);
}

function pluginReleasesRoot(relRoot) {
  return path.join(relRoot, "plugins");
}

function readlinkAbs(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function lnSfn(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.rmSync(linkPath, { force: true, recursive: true });
  } catch {}
  fs.symlinkSync(target, linkPath);
}

function assertSymlink(p, what) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) {
      fail(`${what} must be a symlink at ${p}`);
    }
  } catch {
    // ok if missing
  }
}

function tgzInternalVersion(tgzPath) {
  const raw = execFileSync("tar", ["-xOzf", tgzPath, "package/package.json"], {
    encoding: "utf8",
  });
  const obj = JSON.parse(raw);
  return { name: obj?.name, version: obj?.version };
}

function assertReleaseStoreConsistent(relRoot) {
  if (!fs.existsSync(relRoot)) return;
  const entries = fs.readdirSync(relRoot, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.startsWith("v") || !e.name.endsWith(".tgz")) continue;
    const m = e.name.match(/^v(.+?)(?:-poly\.\d+)?\.tgz$/);
    if (!m) continue;
    const expected = m[1];
    const full = path.join(relRoot, e.name);
    const info = tgzInternalVersion(full);
    if (info.name !== "openclaw") {
      fail(`release store corruption: ${e.name} package name ${info.name}`);
    }
    if (info.version !== expected) {
      fail(
        `release store corruption: ${e.name} contains version ${info.version} (expected ${expected})`,
      );
    }
  }
}

function getGlobalPrefix() {
  // Prefer explicit npm prefix; else default to ~/.npm-global used by the gateway service.
  const p = process.env.OPENCLAW_GLOBAL_PREFIX;
  if (p) return p;
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
        return;
      }
      reject(
        new Error(
          `command failed: ${cmd} ${args.join(" ")} (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  });
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    } catch (e) {
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
  if (m1) return m1[1];
  const m2 = url.match(/github\.com[:/](.+?)$/);
  if (m2) return m2[1];
  fail(`could not infer GitHub repo from origin url: ${url}`);
}

function computeNextReleaseTag() {
  // base version comes from package.json
  const ver = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  // next poly is global max + 1
  const tags = sh("git", ["tag", "-l", "v*-poly.*"]);
  let maxN = -1;
  for (const line of tags.split(/\r?\n/)) {
    const m = line.match(/-poly\.(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > maxN) maxN = n;
  }
  const nextN = maxN + 1;
  return `v${ver}-poly.${nextN}`;
}

function parseReleaseTagPolyNumber(tag) {
  const match = /^v.+-poly\.(\d+)$/.exec(tag);
  return match ? Number(match[1]) : null;
}

function findPreviousReleaseTag(currentTag) {
  const currentPoly = parseReleaseTagPolyNumber(currentTag);
  if (!Number.isFinite(currentPoly)) {
    return null;
  }
  const tags = sh("git", ["tag", "-l", "v*-poly.*"])
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

function parseArgs(argv) {
  // Supported:
  //   node scripts/polytropos-release.mjs release [--tag v<ver>-poly.<N>] [--repo <owner/repo>] [--workflow <workflow.yml>] [--log <path>]
  //   node scripts/polytropos-release.mjs install <tgz> [--log <path>]
  const args = argv.slice(2);
  const cmd = args[0] || "";
  let logPath = process.env.POLYTROPOS_RELEASE_LOG || defaultLogPath();
  let repo = null;
  let workflow = null;
  let releaseTag = null;
  let installTgz = null;
  let baseRef = null;
  let headRef = null;

  if (cmd === "install") {
    installTgz = args[1] || null;
    if (!installTgz) {
      fail("install requires <tgz>");
    }
  }

  for (let i = cmd === "install" ? 2 : 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--log") {
      const v = args[i + 1];
      if (!v) fail("--log requires a path");
      logPath = v;
      i++;
      continue;
    }
    if (a === "--repo") {
      const v = args[i + 1];
      if (!v) fail("--repo requires owner/repo");
      repo = v;
      i++;
      continue;
    }
    if (a === "--workflow") {
      const v = args[i + 1];
      if (!v) fail("--workflow requires a filename (e.g. polytropos-build-pack.yml)");
      workflow = v;
      i++;
      continue;
    }
    if (a === "--tag") {
      const v = args[i + 1];
      if (!v) fail("--tag requires v<ver>-poly.<N>");
      releaseTag = v;
      i++;
      continue;
    }
    if (a === "--base-ref") {
      const v = args[i + 1];
      if (!v) fail("--base-ref requires a git ref");
      baseRef = v;
      i++;
      continue;
    }
    if (a === "--head-ref") {
      const v = args[i + 1];
      if (!v) fail("--head-ref requires a git ref");
      headRef = v;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      return { cmd: "--help", logPath, repo, workflow, releaseTag, installTgz, baseRef, headRef };
    }
    fail(`unknown argument: ${a}`);
  }

  if ((baseRef && !headRef) || (!baseRef && headRef)) {
    fail("install requires both --base-ref and --head-ref together");
  }

  return { cmd, logPath, repo, workflow, releaseTag, installTgz, baseRef, headRef };
}

function usage() {
  console.log(`polytropos-release.mjs

Usage:
  node scripts/polytropos-release.mjs release [--tag v<ver>-poly.<N>] [--repo <owner/repo>] [--workflow <workflow.yml>] [--log <path>]
  node scripts/polytropos-release.mjs install <tgz> [--base-ref <ref> --head-ref <ref>] [--log <path>]

Behavior (single flow):
  - Pushes the release tag to GitHub
  - Waits for the GitHub Actions workflow run for that tag to complete
  - Downloads the artifact openclaw-tgz-<tag>
  - Stages it into ~/polytropos/releases/<tag>.tgz
  - Updates previous.tgz then current.tgz (symlink-safe)
  - Calls install <tgz> to perform the final package install steps
  - install <tgz> performs the global install, bundled deps helper, and managed plugin sync
  - Does not activate/restart the gateway
`);
}

async function runInstall({ logStream, tgzPath, baseRef, headRef }) {
  const resolvedTgzPath = path.resolve(tgzPath);
  if (!fs.existsSync(resolvedTgzPath)) {
    fail(`install tgz does not exist: ${resolvedTgzPath}`);
  }
  const info = tgzInternalVersion(resolvedTgzPath);
  if (info.name !== "openclaw") {
    fail(`unexpected package name in install tgz: ${info.name}`);
  }
  banner(logStream, `Installing tgz ${resolvedTgzPath} (version ${info.version})`);

  const prefix = getGlobalPrefix();
  banner(logStream, `Installing globally into prefix: ${prefix}`);
  {
    const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
    const installedRoot = path.join(npmRoot, "openclaw");
    if (fs.existsSync(installedRoot)) {
      const bak = `${installedRoot}.bak-${timestampForFilename()}`;
      banner(logStream, `Moving aside existing global install: ${installedRoot} -> ${bak}`);
      fs.renameSync(installedRoot, bak);
    }
  }

  await shRetry(logStream, "npm install -g", async () => {
    await shTee(logStream, "npm", ["install", "-g", "--prefix", prefix, resolvedTgzPath]);
  });

  banner(logStream, "Running Polytropos bundled plugin deps helper...");
  {
    const npmRoot = sh("npm", ["root", "-g", "--prefix", prefix]);
    const installedRoot = path.join(npmRoot, "openclaw");
    const helperPath = path.join(
      installedRoot,
      "scripts",
      "polytropos-bundled-plugin-deps-helper.mjs",
    );
    if (!fs.existsSync(helperPath)) {
      fail(`Polytropos helper not found at ${helperPath}`);
    }
    await shRetry(logStream, "bundled deps helper", async () => {
      await shTee(logStream, "node", [helperPath]);
    });
    banner(logStream, "Bundled plugin deps helper completed.");

    banner(logStream, "Syncing release-updated installed plugins...");
    const pluginSyncCommand = buildPostInstallPluginSyncCommand({
      repoRoot: REPO_ROOT,
      installedRoot,
      baseRef,
      headRef,
    });
    await shRetry(logStream, "release plugin sync", async () => {
      await shTee(logStream, pluginSyncCommand.cmd, pluginSyncCommand.args, {
        cwd: pluginSyncCommand.cwd,
      });
    });
    banner(logStream, "Release plugin sync completed.");
  }

  banner(logStream, "Activation required: restart the gateway to run the new code");
  banner(logStream, `Install completed for version ${info.version} (not activated).`);
}

const {
  cmd,
  logPath,
  repo,
  workflow,
  releaseTag: requestedTag,
  installTgz,
  baseRef,
  headRef,
} = parseArgs(process.argv);
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
    await runInstall({ logStream, tgzPath: installTgz, baseRef, headRef });
  } else {
    const releaseTag = requestedTag ?? computeNextReleaseTag();
    if (!/^v.+-poly\.\d+$/.test(releaseTag)) {
      fail(`invalid --tag: ${releaseTag} (expected v<ver>-poly.<N>)`);
    }

    const ghRepo = repo || inferGhRepoFromOrigin();
    const wf = workflow || "polytropos-build-pack.yml";

    banner(logStream, `GitHub repo: ${ghRepo}`);
    banner(logStream, `Workflow: ${wf}`);
    banner(logStream, `Release tag: ${releaseTag}`);
    const previousReleaseTag = findPreviousReleaseTag(releaseTag);
    if (previousReleaseTag) {
      banner(logStream, `Previous release tag: ${previousReleaseTag}`);
    } else {
      banner(logStream, "Previous release tag: none");
    }

    const releaseBranch = assertValidReleaseBranch();
    banner(logStream, `Release branch: ${releaseBranch}`);

    const relRoot = releasesRoot();
    fs.mkdirSync(relRoot, { recursive: true });
    fs.mkdirSync(pluginReleasesRoot(relRoot), { recursive: true });
    assertReleaseStoreConsistent(relRoot);

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
    const runId = await findRunIdForTag({ logStream, ghRepo, wf, releaseTag });

    banner(logStream, `Watching run: ${runId}`);
    await shTee(logStream, "gh", ["run", "watch", runId, "--repo", ghRepo, "--exit-status"]);

    const artifact = `openclaw-tgz-${releaseTag}`;
    const inventoryArtifact = `polytropos-package-inventory-${releaseTag}`;
    const tmpDir = fs.mkdtempSync(path.join(resolveHome(), ".openclaw", "tmp-release-"));

    banner(logStream, `Downloading artifact ${artifact} to ${tmpDir}`);
    await shTee(logStream, "gh", [
      "run",
      "download",
      runId,
      "--repo",
      ghRepo,
      "-n",
      artifact,
      "--dir",
      tmpDir,
    ]);

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

    function findTgz(dir) {
      const matches = [];
      const stack = [dir];
      while (stack.length) {
        const d = stack.pop();
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const pth = path.join(d, ent.name);
          if (ent.isDirectory()) stack.push(pth);
          else if (ent.isFile() && ent.name.endsWith(".tgz")) matches.push(pth);
        }
      }
      return matches;
    }

    const tgzs = findTgz(tmpDir);
    if (tgzs.length !== 1) {
      fail(`expected exactly one .tgz in artifact, found ${tgzs.length}: ${tgzs.join(", ")}`);
    }
    const tgzPath = tgzs[0];
    const expectedVersion = releaseTag.replace(/^v/, "").replace(/-poly\.\d+$/, "");

    {
      const info = tgzInternalVersion(tgzPath);
      if (info.name !== "openclaw") {
        fail(`unexpected package name in tgz: ${info.name}`);
      }
      if (info.version !== expectedVersion) {
        fail(`tgz version ${info.version} != expected ${expectedVersion} (from ${releaseTag})`);
      }
    }

    const tarPath = path.join(relRoot, `${releaseTag}.tgz`);
    const inventoryPath = inventoryPathForTag(relRoot, releaseTag);
    if (fs.existsSync(tarPath)) {
      banner(logStream, `Tarball already staged: ${tarPath}`);
      const info = tgzInternalVersion(tarPath);
      if (info.name !== "openclaw") {
        fail(`unexpected package name in existing tgz: ${info.name}`);
      }
      if (info.version !== expectedVersion) {
        fail(
          `existing tgz version ${info.version} != expected ${expectedVersion} (from ${releaseTag})`,
        );
      }
    } else {
      fs.copyFileSync(tgzPath, tarPath);
    }

    const foundInventory = path.join(tmpDir, "polytropos-package-inventory.json");
    if (!fs.existsSync(foundInventory)) {
      fail(`expected downloaded inventory artifact at ${foundInventory}`);
    }
    fs.copyFileSync(foundInventory, inventoryPath);

    banner(logStream, `Staged tarball: ${tarPath}`);
    banner(logStream, `Staged package inventory: ${inventoryPath}`);
    const currentTgz = path.join(relRoot, "current.tgz");
    assertSymlink(currentTgz, "current.tgz");
    const previousTgz = path.join(relRoot, "previous.tgz");
    assertSymlink(previousTgz, "previous.tgz");
    const currentTarget = readlinkAbs(currentTgz);
    if (currentTarget) {
      banner(logStream, `Setting previous.tgz -> ${currentTarget}`);
      lnSfn(currentTarget, previousTgz);
    } else {
      banner(
        logStream,
        "No existing current.tgz symlink; setting previous.tgz to this tarball as bootstrap",
      );
      lnSfn(tarPath, previousTgz);
    }

    banner(logStream, `Setting current.tgz -> ${tarPath}`);
    lnSfn(tarPath, currentTgz);
    banner(logStream, `Delegating install for staged release artifact ${currentTgz}`);
    const installCommand = buildInstallCommand({
      repoRoot: REPO_ROOT,
      tgzPath: currentTgz,
      baseRef: previousReleaseTag ?? undefined,
      headRef: releaseTag,
      logPath,
    });
    await shTee(logStream, installCommand.cmd, installCommand.args);
    banner(logStream, "Release staged and install delegated (not activated).");
  }
} finally {
  logStream.end();
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
