import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstallCommand } from "../../scripts/lib/polytropos-release-install.mjs";
import { buildPostInstallPluginSyncCommand } from "../../scripts/lib/polytropos-release-plugin-sync.mjs";
import { resolveReleaseManagedNpmPluginTargets } from "../../scripts/polytropos-release-plugin-sync.ts";

describe("polytropos release helpers", () => {
  it("builds an install command that delegates back into the release script with a tgz path", () => {
    const repoRoot = "/work/openclaw";
    expect(
      buildInstallCommand({
        repoRoot,
        tgzPath: "/tmp/openclaw-current.tgz",
        baseRef: "v2026.6.1+poly.52",
        headRef: "v2026.6.1+poly.53",
        logPath: "/tmp/polytropos-release.log",
      }),
    ).toEqual({
      cmd: "node",
      args: [
        path.join(repoRoot, "scripts", "polytropos-release.mjs"),
        "install",
        "/tmp/openclaw-current.tgz",
        "--base-ref",
        "v2026.6.1+poly.52",
        "--head-ref",
        "v2026.6.1+poly.53",
        "--log",
        "/tmp/polytropos-release.log",
      ],
    });
  });

  it("runs the release-owned plugin sync helper against the freshly installed package root", () => {
    const repoRoot = "/work/openclaw";
    const installedRoot = "/tmp/npm-prefix/lib/node_modules/openclaw";
    expect(
      buildPostInstallPluginSyncCommand({
        repoRoot,
        installedRoot,
        baseRef: "v2026.6.1+poly.52",
        headRef: "v2026.6.1+poly.53",
      }),
    ).toEqual({
      cmd: path.join(repoRoot, "node_modules", ".bin", "tsx"),
      args: [
        path.join(repoRoot, "scripts", "polytropos-release-plugin-sync.ts"),
        installedRoot,
        "v2026.6.1+poly.52",
        "v2026.6.1+poly.53",
      ],
      cwd: repoRoot,
    });
  });

  it("selects managed publishable npm installs when no git range is provided", () => {
    const { version: releaseVersion } = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };
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
      releaseVersion,
      specOverride: `@openclaw/codex@${releaseVersion}`,
    });
    expect(targets).toContainEqual({
      pluginId: "discord",
      packageName: "@openclaw/discord",
      installedVersion: "2026.6.1",
      releaseVersion,
      specOverride: `@openclaw/discord@${releaseVersion}`,
    });
    expect(targets.some((entry) => entry.pluginId === "custom")).toBe(false);
  });
});
