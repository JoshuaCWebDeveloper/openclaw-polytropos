import path from "node:path";

export function buildInstallCommand(params) {
  const args = [
    path.join(params.repoRoot, "scripts", "polytropos-release.mjs"),
    "install",
    path.resolve(params.tgzPath),
  ];
  if (params.baseRef && params.headRef) {
    args.push("--base-ref", params.baseRef, "--head-ref", params.headRef);
  }
  if (params.logPath) {
    args.push("--log", params.logPath);
  }
  if (params.pluginSyncConfig && params.pluginSyncConfig !== "auto") {
    args.push("--plugin-sync-config", params.pluginSyncConfig);
  }
  return {
    cmd: "node",
    args,
  };
}
