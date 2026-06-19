export const GITHUB_PACKAGES_REGISTRY_URL = "https://npm.pkg.github.com";

const POLYTROPOS_RELEASE_TAG_REGEX = /^v(?<base>\d{4}\.\d+\.\d+)\+poly\.(?<correction>[1-9]\d*)$/;
const STABLE_VERSION_REGEX = /^(?<base>\d{4}\.\d+\.\d+)$/;
const CORRECTION_VERSION_REGEX = /^(?<base>\d{4}\.\d+\.\d+)-(?<correction>[1-9]\d*)$/;

function normalizeScope(rawScope: string): string {
  const normalized = rawScope.trim().replace(/^@/, "").toLowerCase();
  if (!normalized) {
    throw new Error("GitHub package scope must be non-empty.");
  }
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new Error(`GitHub package scope must be lowercase alphanumeric or hyphen: ${rawScope}`);
  }
  return normalized;
}

export function resolvePolytroposGithubPackageScope(rawScope: string): string {
  return `@${normalizeScope(rawScope)}`;
}

export function resolvePolytroposGithubPublishedPackageName(params: {
  packageName: string;
  githubScope: string;
}): string {
  const scope = resolvePolytroposGithubPackageScope(params.githubScope);
  const packageName = params.packageName.trim();
  if (!packageName) {
    throw new Error("Tracked package name must be non-empty.");
  }
  if (packageName === "openclaw") {
    return `${scope}/openclaw-polytropos-core`;
  }
  const suffix = packageName.split("/").at(-1)?.trim();
  if (!suffix) {
    throw new Error(`Could not resolve published package suffix for ${packageName}`);
  }
  return `${scope}/openclaw-polytropos-${suffix}`;
}

export function resolvePolytroposPackageVersionFromReleaseTag(releaseTag: string): string {
  const normalized = releaseTag.trim();
  const match = POLYTROPOS_RELEASE_TAG_REGEX.exec(normalized);
  if (!match?.groups) {
    throw new Error(`Invalid Polytropos release tag: ${releaseTag}`);
  }
  return `${match.groups.base}-${match.groups.correction}`;
}

export function resolveNextPolytroposPublishedPackageVersion(params: {
  releaseTag: string;
  latestPublishedVersion?: string | null;
}): string {
  const normalizedTag = params.releaseTag.trim();
  const releaseTagMatch = POLYTROPOS_RELEASE_TAG_REGEX.exec(normalizedTag);
  if (!releaseTagMatch?.groups) {
    throw new Error(`Invalid Polytropos release tag: ${params.releaseTag}`);
  }

  const baseVersion = releaseTagMatch.groups.base;
  const latestPublishedVersion = params.latestPublishedVersion?.trim() ?? "";
  if (!latestPublishedVersion) {
    return `${baseVersion}-1`;
  }

  const correctionMatch = CORRECTION_VERSION_REGEX.exec(latestPublishedVersion);
  if (correctionMatch?.groups?.base === baseVersion) {
    const correctionNumber = Number.parseInt(correctionMatch.groups.correction, 10);
    if (Number.isInteger(correctionNumber) && correctionNumber >= 1) {
      return `${baseVersion}-${correctionNumber + 1}`;
    }
  }

  const stableMatch = STABLE_VERSION_REGEX.exec(latestPublishedVersion);
  if (stableMatch?.groups?.base === baseVersion) {
    return `${baseVersion}-1`;
  }

  return `${baseVersion}-1`;
}
