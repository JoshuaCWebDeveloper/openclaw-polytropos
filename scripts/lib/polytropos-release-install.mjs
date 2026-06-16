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
