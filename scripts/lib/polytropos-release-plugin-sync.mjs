import path from "node:path";

export function buildPostInstallPluginSyncCommand(params) {
  return {
    cmd: "node",
    args: [
      "--import",
      "tsx",
      path.join(params.repoRoot, "scripts", "polytropos-release-plugin-sync.ts"),
      path.resolve(params.installedRoot),
    ],
  };
}
