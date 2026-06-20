import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstallCommand } from "../../scripts/lib/polytropos-release-install.mjs";
import { buildPostInstallPluginSyncCommand } from "../../scripts/lib/polytropos-release-plugin-sync.mjs";
import { resolveReleaseManagedNpmPluginTargets } from "../../scripts/polytropos-release-plugin-sync.ts";
import {
  createSanitizedTemporaryConfigPath,
  parseArgs,
} from "../../scripts/polytropos-release.mjs";

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

  it("passes explicit sanitized config mode through delegated install commands", () => {
    const repoRoot = "/work/openclaw";
    expect(
      buildInstallCommand({
        repoRoot,
        tgzPath: "/tmp/openclaw-current.tgz",
        baseRef: "v2026.6.1-poly.69",
        headRef: "v2026.6.1-poly.70",
        logPath: "/tmp/polytropos-release.log",
        pluginSyncConfig: "sanitized-temp",
      }),
    ).toEqual({
      cmd: "node",
      args: [
        path.join(repoRoot, "scripts", "polytropos-release.mjs"),
        "install",
        "/tmp/openclaw-current.tgz",
        "--base-ref",
        "v2026.6.1-poly.69",
        "--head-ref",
        "v2026.6.1-poly.70",
        "--log",
        "/tmp/polytropos-release.log",
        "--plugin-sync-config",
        "sanitized-temp",
      ],
    });
  });

  it("parses existing release run reuse without requesting a new poly tag", () => {
    expect(
      parseArgs([
        "node",
        "scripts/polytropos-release.mjs",
        "release",
        "--tag",
        "v2026.6.1-poly.70",
        "--run-id",
        "123456789",
        "--rerun-run",
        "--repo",
        "openclaw/openclaw",
      ]),
    ).toMatchObject({
      cmd: "release",
      releaseTag: "v2026.6.1-poly.70",
      runId: "123456789",
      rerunRun: true,
      repo: "openclaw/openclaw",
    });
  });

  it("creates a sanitized temporary config by deleting only session.reset", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-release-test-"));
    const liveConfigPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      liveConfigPath,
      JSON.stringify(
        {
          plugins: {
            entries: {
              codex: {
                enabled: true,
                config: { provider: "openai" },
              },
            },
          },
          session: {
            reset: { invalidLegacyObject: true },
            maintenance: { maxAgeDays: 30 },
          },
        },
        null,
        2,
      ),
    );
    const configPath = createSanitizedTemporaryConfigPath({
      ...process.env,
      OPENCLAW_CONFIG_PATH: liveConfigPath,
    });
    try {
      const sanitized = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(path.dirname(configPath)).toBe(root);
      expect(sanitized.plugins.entries.codex).toEqual({
        enabled: true,
        config: { provider: "openai" },
      });
      expect(sanitized.session).toEqual({ maintenance: { maxAgeDays: 30 } });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
      registryPackageName: "@openclaw/codex",
      installedVersion: "2026.5.1",
      releaseVersion,
      specOverride: `@openclaw/codex@${releaseVersion}`,
    });
    expect(targets).toContainEqual({
      pluginId: "discord",
      packageName: "@openclaw/discord",
      registryPackageName: "@openclaw/discord",
      installedVersion: "2026.6.1",
      releaseVersion,
      specOverride: `@openclaw/discord@${releaseVersion}`,
    });
    expect(targets.some((entry) => entry.pluginId === "custom")).toBe(false);
  });

  it("uses published package names from inventory for registry fetches", () => {
    const targets = resolveReleaseManagedNpmPluginTargets({
      repoRoot: process.cwd(),
      installRecords: {
        codex: {
          source: "npm",
          spec: "npm:@openclaw/codex",
          resolvedName: "@openclaw/codex",
          resolvedVersion: "2026.6.1",
        },
      },
      inventory: {
        packages: [
          {
            packageName: "@openclaw/codex",
            packageType: "plugin",
            latestVersion: "2026.6.1-poly.69",
            changed: true,
            artifactUrl:
              "https://npm.pkg.github.com/download/@joshuacwebdeveloper/openclaw-polytropos-codex/2026.6.1-poly.69/archive",
            integrity: "sha512-test",
            publishedPackageName: "@joshuacwebdeveloper/openclaw-polytropos-codex",
          },
        ],
      },
    });

    expect(targets).toEqual([
      {
        pluginId: "codex",
        packageName: "@openclaw/codex",
        registryPackageName: "@joshuacwebdeveloper/openclaw-polytropos-codex",
        installedVersion: "2026.6.1",
        releaseVersion: "2026.6.1-poly.69",
        specOverride: "@openclaw/codex@2026.6.1-poly.69",
        artifactUrl:
          "https://npm.pkg.github.com/download/@joshuacwebdeveloper/openclaw-polytropos-codex/2026.6.1-poly.69/archive",
        integrity: "sha512-test",
      },
    ]);
  });
});
