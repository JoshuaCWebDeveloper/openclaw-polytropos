import path from "node:path";

export function buildPostInstallPluginSyncCommand(params) {
  const args = [
    path.join(params.repoRoot, "scripts", "polytropos-release-plugin-sync.ts"),
    path.resolve(params.installedRoot),
  ];
  if (params.baseRef && params.headRef) {
    args.push(params.baseRef, params.headRef);
  }
  return {
    cmd: path.join(params.repoRoot, "node_modules", ".bin", "tsx"),
    args,
    cwd: params.repoRoot,
  };
}
