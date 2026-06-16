import path from "node:path";

export function buildPostInstallPluginSyncCommand(params) {
  return {
    cmd: path.join(params.repoRoot, "node_modules", ".bin", "tsx"),
    args: [
      path.join(params.repoRoot, "scripts", "polytropos-release-plugin-sync.ts"),
      path.resolve(params.installedRoot),
    ],
    cwd: params.repoRoot,
  };
}
