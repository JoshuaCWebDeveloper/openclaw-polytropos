import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const GITHUB_PACKAGES_REGISTRY_URL = "https://npm.pkg.github.com";
const GITHUB_PACKAGES_HOST = "npm.pkg.github.com";

function sanitizePackageSegment(value) {
  return value
    .replace(/^@/u, "")
    .replaceAll("/", "-")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function trimmedEnvValue(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readGhAuthToken() {
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function resolveGitHubPackagesAuthToken({
  env = process.env,
  readGhAuthTokenImpl = readGhAuthToken,
} = {}) {
  return (
    trimmedEnvValue(env, "NODE_AUTH_TOKEN") ??
    trimmedEnvValue(env, "GITHUB_TOKEN") ??
    trimmedEnvValue(env, "GH_TOKEN") ??
    trimmedEnvValue(env, "NPM_TOKEN") ??
    readGhAuthTokenImpl()?.trim() ??
    null
  );
}

function resolvePackageScope(packageName) {
  const match = /^@([^/]+)\//u.exec(packageName);
  return match?.[1] ? `@${match[1]}` : null;
}

function isGitHubPackagesUrl(url) {
  try {
    return new URL(url).hostname === GITHUB_PACKAGES_HOST;
  } catch {
    return false;
  }
}

export function resolveReleasePackageRegistryUrl(artifactUrl) {
  return artifactUrl && isGitHubPackagesUrl(artifactUrl) ? GITHUB_PACKAGES_REGISTRY_URL : null;
}

export function resolvePackageReleaseStoreDir(relRoot) {
  return path.join(relRoot, "packages");
}

export function resolveStoredReleasePackagePath(relRoot, { packageName, version }) {
  const safePackage = sanitizePackageSegment(packageName);
  const safeVersion = sanitizePackageSegment(version);
  return path.join(resolvePackageReleaseStoreDir(relRoot), `${safePackage}-${safeVersion}.tgz`);
}

function readStoredPackageMetadata(tgzPath) {
  const raw = execFileSync("tar", ["-xOzf", tgzPath, "package/package.json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(raw);
  return {
    name: typeof parsed?.name === "string" ? parsed.name : "",
    version: typeof parsed?.version === "string" ? parsed.version : "",
  };
}

export async function downloadArtifactToFile(
  url,
  targetPath,
  { env = process.env, readGhAuthTokenImpl = readGhAuthToken } = {},
) {
  const headers = {};
  if (isGitHubPackagesUrl(url)) {
    const token = resolveGitHubPackagesAuthToken({ env, readGhAuthTokenImpl });
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
  }
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    const authHint = isGitHubPackagesUrl(url)
      ? "; GitHub Packages downloads require NODE_AUTH_TOKEN, GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, or gh auth"
      : "";
    throw new Error(`artifact download failed: ${url} (HTTP ${response.status})${authHint}`);
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

export async function stageRegistryPackageArchive({
  packageName,
  version,
  targetPath,
  registryUrl,
  env = process.env,
  execFileSyncImpl = execFileSync,
  readGhAuthTokenImpl = readGhAuthToken,
}) {
  const stagingDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "openclaw-polytropos-package-pack-"),
  );
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    const npmArgs = ["pack", `${packageName}@${version}`, "--pack-destination", stagingDir];
    const npmEnv = { ...env };
    if (registryUrl) {
      npmArgs.push("--registry", registryUrl);
    }
    if (registryUrl === GITHUB_PACKAGES_REGISTRY_URL) {
      const token = resolveGitHubPackagesAuthToken({ env, readGhAuthTokenImpl });
      if (token) {
        const npmrcPath = path.join(stagingDir, ".npmrc");
        const scope = resolvePackageScope(packageName);
        const scopeLine = scope ? `${scope}:registry=${GITHUB_PACKAGES_REGISTRY_URL}\n` : "";
        await fs.promises.writeFile(
          npmrcPath,
          `${scopeLine}//${GITHUB_PACKAGES_HOST}/:_authToken=\${NODE_AUTH_TOKEN}\nalways-auth=true\n`,
          { mode: 0o600 },
        );
        npmEnv.NODE_AUTH_TOKEN = token;
        npmEnv.NPM_CONFIG_USERCONFIG = npmrcPath;
        npmEnv.npm_config_userconfig = npmrcPath;
      }
    }
    npmArgs.push("--silent");
    const rawOutput = execFileSyncImpl("npm", npmArgs, {
      encoding: "utf8",
      env: npmEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  env = process.env,
  stageRegistryPackageArchiveImpl = stageRegistryPackageArchive,
  downloadArtifactToFileImpl = downloadArtifactToFile,
}) {
  const storedPath = resolveStoredReleasePackagePath(relRoot, {
    packageName,
    version,
  });
  if (fs.existsSync(storedPath)) {
    try {
      const metadata = readStoredPackageMetadata(storedPath);
      const allowedNames = new Set([packageName, registryPackageName].filter(Boolean));
      if (metadata.version === version && allowedNames.has(metadata.name)) {
        logger?.info?.(`Reusing stored release package ${storedPath}.`);
        return storedPath;
      }
      logger?.warn?.(
        `Replacing stored release package ${storedPath} because it contains ${metadata.name}@${metadata.version}, expected ${Array.from(
          allowedNames,
        ).join(" or ")}@${version}.`,
      );
    } catch (error) {
      logger?.warn?.(
        `Replacing unreadable stored release package ${storedPath}: ${String(error instanceof Error ? error.message : error)}`,
      );
    }
    await fs.promises.rm(storedPath, { force: true });
  }

  try {
    await stageRegistryPackageArchiveImpl({
      packageName: registryPackageName || packageName,
      version,
      targetPath: storedPath,
      registryUrl: resolveReleasePackageRegistryUrl(artifactUrl),
      env,
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
    await downloadArtifactToFileImpl(artifactUrl, storedPath, { env });
  }
  return storedPath;
}
