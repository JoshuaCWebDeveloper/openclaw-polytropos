export const GITHUB_PACKAGES_REGISTRY_URL = "https://npm.pkg.github.com";

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
    return `${scope}/openclaw`;
  }
  const suffix = packageName.split("/").at(-1)?.trim();
  if (!suffix) {
    throw new Error(`Could not resolve published package suffix for ${packageName}`);
  }
  return `${scope}/${suffix}`;
}
