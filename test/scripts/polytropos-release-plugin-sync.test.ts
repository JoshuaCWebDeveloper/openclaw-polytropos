import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPostInstallPluginSyncCommand } from "../../scripts/lib/polytropos-release-plugin-sync.mjs";
import { resolveReleaseManagedNpmPluginTargets } from "../../scripts/polytropos-release-plugin-sync.ts";

describe("buildPostInstallPluginSyncCommand", () => {
  it("runs the release-owned plugin sync helper against the freshly installed package root", () => {
    const repoRoot = "/work/openclaw";
    const installedRoot = "/tmp/npm-prefix/lib/node_modules/openclaw";
    expect(buildPostInstallPluginSyncCommand({ repoRoot, installedRoot })).toEqual({
      cmd: "node",
      args: [
        "--import",
        "tsx",
        path.join(repoRoot, "scripts", "polytropos-release-plugin-sync.ts"),
        installedRoot,
      ],
    });
  });

  it("selects only managed npm installs whose package version differs from the release package version", () => {
    const targets = resolveReleaseManagedNpmPluginTargets({
      repoRoot: process.cwd(),
      installRecords: {
        codex: {
          source: "npm",
          spec: "npm:@openclaw/codex",
          resolvedName: "@openclaw/codex",
          resolvedVersion: "2026.5.1",
        },
        discord: {
          source: "npm",
          spec: "npm:@openclaw/discord",
          resolvedName: "@openclaw/discord",
          resolvedVersion: "2026.6.1",
        },
        custom: {
          source: "npm",
          spec: "npm:@acme/custom-plugin",
          resolvedName: "@acme/custom-plugin",
          resolvedVersion: "1.2.3",
        },
      },
    });

    expect(targets).toContainEqual({
      pluginId: "codex",
      packageName: "@openclaw/codex",
      installedVersion: "2026.5.1",
      releaseVersion: "2026.6.1",
      specOverride: "@openclaw/codex@2026.6.1",
    });
    expect(targets.some((entry) => entry.pluginId === "discord")).toBe(false);
    expect(targets.some((entry) => entry.pluginId === "custom")).toBe(false);
  });
});
