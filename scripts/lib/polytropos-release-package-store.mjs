import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

function sanitizePackageSegment(value) {
  return value
    .replace(/^@/u, "")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function resolvePackageReleaseStoreDir(relRoot) {
  return path.join(relRoot, "packages");
}

export function resolveStoredReleasePackagePath(relRoot, { packageName, version }) {
  const safePackage = sanitizePackageSegment(packageName);
  const safeVersion = sanitizePackageSegment(version);
  return path.join(resolvePackageReleaseStoreDir(relRoot), `${safePackage}-${safeVersion}.tgz`);
}

export async function downloadArtifactToFile(url, targetPath) {
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

export async function stageRegistryPackageArchive({ packageName, version, targetPath }) {
  const stagingDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "openclaw-polytropos-package-pack-"),
  );
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    const rawOutput = execFileSync(
      "npm",
      ["pack", `${packageName}@${version}`, "--pack-destination", stagingDir, "--silent"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const fileName = rawOutput
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .findLast(Boolean);
    if (!fileName) {
      throw new Error(`npm pack did not report an archive filename for ${packageName}@${version}`);
    }
    const stagedPackPath = path.join(stagingDir, fileName);
    if (!fs.existsSync(stagedPackPath)) {
      throw new Error(`npm pack did not produce ${fileName} for ${packageName}@${version}`);
    }
    await fs.promises.rm(targetPath, { force: true });
    await fs.promises.copyFile(stagedPackPath, targetPath);
    await fs.promises.rm(stagedPackPath, { force: true });
  } finally {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}

export async function ensureStoredReleasePackage({
  relRoot,
  packageName,
  registryPackageName,
  version,
  artifactUrl,
  logger,
}) {
  const storedPath = resolveStoredReleasePackagePath(relRoot, {
    packageName,
    version,
  });
  if (fs.existsSync(storedPath)) {
    logger?.info?.(`Reusing stored release package ${storedPath}.`);
    return storedPath;
  }

  try {
    await stageRegistryPackageArchive({
      packageName: registryPackageName || packageName,
      version,
      targetPath: storedPath,
    });
  } catch (npmPackError) {
    if (!artifactUrl) {
      throw npmPackError;
    }
    logger?.warn?.(
      `npm pack failed for ${registryPackageName || packageName}@${version}; falling back to artifact URL download: ${String(
        npmPackError,
      )}`,
    );
    await downloadArtifactToFile(artifactUrl, storedPath);
  }
  return storedPath;
}
