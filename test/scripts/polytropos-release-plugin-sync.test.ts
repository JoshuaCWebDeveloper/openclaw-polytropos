import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInstallCommand,
  findLatestStagedTarballForVersion,
} from "../../scripts/lib/polytropos-release-install.mjs";
import { buildPostInstallPluginSyncCommand } from "../../scripts/lib/polytropos-release-plugin-sync.mjs";
import { resolveReleaseManagedNpmPluginTargets } from "../../scripts/polytropos-release-plugin-sync.ts";

describe("polytropos release helpers", () => {
  it("builds an install command that delegates back into the release script", () => {
    const repoRoot = "/work/openclaw";
    expect(
      buildInstallCommand({
        repoRoot,
        version: "2026.6.1",
        logPath: "/tmp/polytropos-release.log",
      }),
    ).toEqual({
      cmd: "node",
      args: [
        path.join(repoRoot, "scripts", "polytropos-release.mjs"),
        "install",
        "2026.6.1",
        "--log",
        "/tmp/polytropos-release.log",
      ],
    });
  });

  it("selects the newest staged tarball for an install version", () => {
    const relRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polytropos-release-"));
    fs.writeFileSync(path.join(relRoot, "v2026.6.1+poly.0.tgz"), "");
    fs.writeFileSync(path.join(relRoot, "v2026.6.1+poly.3.tgz"), "");
    fs.writeFileSync(path.join(relRoot, "v2026.6.2+poly.1.tgz"), "");

    expect(
      findLatestStagedTarballForVersion({
        relRoot,
        version: "2026.6.1",
      }),
    ).toBe(path.join(relRoot, "v2026.6.1+poly.3.tgz"));
  });

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
