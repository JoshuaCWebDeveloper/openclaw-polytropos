import path from "node:path";

export function buildPostInstallPluginSyncCommand(params) {
  const args = [
    path.join(params.repoRoot, "scripts", "polytropos-release-plugin-sync.ts"),
    path.resolve(params.installedRoot),
  ];
  if (params.headRef) {
    args.push("--head-ref", params.headRef);
  }
  if (params.baseRef) {
    args.push("--base-ref", params.baseRef);
  }
  return {
    cmd: path.join(params.repoRoot, "node_modules", ".bin", "tsx"),
    args,
    cwd: params.repoRoot,
  };
}
