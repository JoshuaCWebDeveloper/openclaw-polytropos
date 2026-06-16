import fs from "node:fs";
import path from "node:path";

export function buildInstallCommand(params) {
  const args = [
    path.join(params.repoRoot, "scripts", "polytropos-release.mjs"),
    "install",
    params.version,
  ];
  if (params.logPath) {
    args.push("--log", params.logPath);
  }
  return {
    cmd: "node",
    args,
  };
}

export function findLatestStagedTarballForVersion(params) {
  const prefix = `v${params.version}+poly.`;
  let best = null;

  for (const entry of fs.readdirSync(params.relRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tgz")) {
      continue;
    }
    const match = entry.name.match(/^v(.+)\+poly\.(\d+)\.tgz$/);
    if (!match) {
      continue;
    }
    const [, version, polyBuild] = match;
    if (version !== params.version || !entry.name.startsWith(prefix)) {
      continue;
    }
    const poly = Number(polyBuild);
    if (!Number.isFinite(poly)) {
      continue;
    }
    if (!best || poly > best.poly) {
      best = {
        poly,
        tarPath: path.join(params.relRoot, entry.name),
      };
    }
  }

  return best?.tarPath ?? null;
}
