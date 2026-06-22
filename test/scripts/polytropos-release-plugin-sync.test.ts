import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInstallCommand } from "../../scripts/lib/polytropos-release-install.mjs";
import {
  downloadArtifactToFile,
  ensureStoredReleasePackage,
  resolvePackageReleaseStoreDir,
  resolveReleasePackageRegistryUrl,
  resolveStoredReleasePackagePath,
  stageRegistryPackageArchive,
} from "../../scripts/lib/polytropos-release-package-store.mjs";
import { buildPostInstallPluginSyncCommand } from "../../scripts/lib/polytropos-release-plugin-sync.mjs";
import {
  repairOpenClawPeerLinksForReleaseInstall,
  resolveReleaseManagedNpmPluginTargets,
} from "../../scripts/polytropos-release-plugin-sync.ts";
import {
  assertReleaseStoreConsistent,
  createSanitizedTemporaryConfigPath,
  ensureLegacyOpenClawPackageAlias,
  parseArgs,
  prepareInstallPackageInput,
  resolvePolytroposReleaseArtifacts,
  resolveReleaseCoreInstallPackagePath,
  resolveInstallPackageInput,
  stageDownloadedReleaseTarball,
  updateReleasePointers,
} from "../../scripts/polytropos-release.mjs";

function createTestPackageTgz(root: string, packageName: string, version: string, marker: string) {
  const pkgDir = path.join(root, `pkg-${version}-${marker}`);
  const packageDir = path.join(pkgDir, "package");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, version }, null, 2),
  );
  fs.writeFileSync(path.join(packageDir, "MARKER.txt"), `${marker}\n`);
  const safePackageName = packageName.replace(/^@/u, "").replaceAll("/", "-");
  const tgzPath = path.join(root, `${safePackageName}-${version}-${marker}.tgz`);
  tar.c({ cwd: pkgDir, file: tgzPath, gzip: true, sync: true }, ["package"]);
  return tgzPath;
}

function createTestOpenClawTgz(root: string, version: string, marker: string) {
  return createTestPackageTgz(root, "openclaw", version, marker);
}

describe("polytropos release helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds an install command that delegates back into the release script with a tgz path", () => {
    const repoRoot = "/work/openclaw";
    expect(
      buildInstallCommand({
        repoRoot,
        tgzPath: "/tmp/polytropos/releases/packages/openclaw-2026.6.1-poly.53.tgz",
        baseRef: "v2026.6.1+poly.52",
        headRef: "v2026.6.1+poly.53",
        logPath: "/tmp/polytropos-release.log",
      }),
    ).toEqual({
      cmd: "node",
      args: [
        path.join(repoRoot, "scripts", "polytropos-release.mjs"),
        "install",
        "/tmp/polytropos/releases/packages/openclaw-2026.6.1-poly.53.tgz",
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
        tgzPath: "/tmp/polytropos/releases/packages/openclaw-2026.6.1-poly.70.tgz",
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
        "/tmp/polytropos/releases/packages/openclaw-2026.6.1-poly.70.tgz",
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

  it("resolves rerun artifacts from the current run tag instead of the requested stale tag", () => {
    expect(
      resolvePolytroposReleaseArtifacts({
        requestedTag: "v2026.6.1-poly.70",
        artifacts: [
          { name: "openclaw-tgz-v2026.6.1-poly.71", expired: false },
          { name: "polytropos-package-inventory-v2026.6.1-poly.71", expired: false },
        ],
      }),
    ).toEqual({
      releaseTag: "v2026.6.1-poly.71",
      tgzArtifact: "openclaw-tgz-v2026.6.1-poly.71",
      inventoryArtifact: "polytropos-package-inventory-v2026.6.1-poly.71",
    });
  });

  it("resolves release artifacts from inventory-only workflow runs", () => {
    expect(
      resolvePolytroposReleaseArtifacts({
        requestedTag: "v2026.6.1-poly.70",
        artifacts: [{ name: "polytropos-package-inventory-v2026.6.1-poly.70", expired: false }],
      }),
    ).toEqual({
      releaseTag: "v2026.6.1-poly.70",
      inventoryArtifact: "polytropos-package-inventory-v2026.6.1-poly.70",
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

  it("reuses an existing staged core tarball when rerunning the same release tag", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-release-stage-test-"));
    const relRoot = path.join(root, "releases");
    fs.mkdirSync(resolvePackageReleaseStoreDir(relRoot), { recursive: true });
    const releaseTag = "v2026.6.1-poly.71";
    const expectedVersion = "2026.6.1";
    const originalTgz = createTestOpenClawTgz(root, expectedVersion, "old");
    const replacementTgz = createTestOpenClawTgz(root, expectedVersion, "new");

    const stagedPath = stageDownloadedReleaseTarball({
      logStream: process.stdout,
      downloadedTgzPath: originalTgz,
      relRoot,
      releaseTag,
      expectedVersion,
    });
    expect(stagedPath).toBe(
      resolveStoredReleasePackagePath(relRoot, {
        packageName: "openclaw",
        version: releaseTag.replace(/^v/, ""),
      }),
    );
    const originalBytes = fs.readFileSync(stagedPath);

    const replacedPath = stageDownloadedReleaseTarball({
      logStream: process.stdout,
      downloadedTgzPath: replacementTgz,
      relRoot,
      releaseTag,
      expectedVersion,
    });

    expect(replacedPath).toBe(stagedPath);
    expect(fs.readFileSync(replacedPath)).toEqual(originalBytes);
    expect(fs.readFileSync(replacedPath)).not.toEqual(fs.readFileSync(replacementTgz));
  });

  it("stores all release packages under releases/packages", () => {
    const relRoot = "/tmp/polytropos/releases";
    expect(resolvePackageReleaseStoreDir(relRoot)).toBe("/tmp/polytropos/releases/packages");
    expect(
      resolveStoredReleasePackagePath(relRoot, {
        packageName: "@openclaw/codex",
        version: "2026.6.1-poly.71",
      }),
    ).toBe("/tmp/polytropos/releases/packages/openclaw-codex-2026.6.1-poly.71.tgz");
  });

  it("reuses an already-downloaded local release package", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-package-reuse-test-"));
    const relRoot = path.join(root, "releases");
    const storedPath = resolveStoredReleasePackagePath(relRoot, {
      packageName: "@openclaw/codex",
      version: "2026.6.1-poly.71",
    });
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    const existingPackage = createTestPackageTgz(
      root,
      "@scope/openclaw-polytropos-codex",
      "2026.6.1-poly.71",
      "existing",
    );
    fs.copyFileSync(existingPackage, storedPath);
    const logs: string[] = [];

    await expect(
      ensureStoredReleasePackage({
        relRoot,
        packageName: "@openclaw/codex",
        registryPackageName: "@scope/openclaw-polytropos-codex",
        version: "2026.6.1-poly.71",
        artifactUrl:
          "https://npm.pkg.github.com/download/@scope/openclaw-polytropos-codex/2026.6.1-poly.71/archive",
        logger: {
          info: (message) => logs.push(message),
          warn: (message) => logs.push(message),
        },
      }),
    ).resolves.toBe(storedPath);
    expect(fs.readFileSync(storedPath)).toEqual(fs.readFileSync(existingPackage));
    expect(logs).toEqual([`Reusing stored release package ${storedPath}.`]);
  });

  it("replaces a cached release package when its contents do not match the requested version", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-package-repair-test-"));
    const relRoot = path.join(root, "releases");
    const storedPath = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: "2026.6.1-poly.71",
    });
    const corruptTgz = createTestOpenClawTgz(root, "2026.6.1", "corrupt");
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    fs.copyFileSync(corruptTgz, storedPath);
    const replacementTgz = createTestPackageTgz(
      root,
      "@joshuacwebdeveloper/openclaw-polytropos-core",
      "2026.6.1-poly.71",
      "replacement",
    );
    const logs: string[] = [];

    try {
      await expect(
        ensureStoredReleasePackage({
          relRoot,
          packageName: "openclaw",
          registryPackageName: "@joshuacwebdeveloper/openclaw-polytropos-core",
          version: "2026.6.1-poly.71",
          artifactUrl:
            "https://npm.pkg.github.com/download/@joshuacwebdeveloper/openclaw-polytropos-core/2026.6.1-poly.71/archive",
          logger: {
            info: (message) => logs.push(message),
            warn: (message) => logs.push(message),
          },
          stageRegistryPackageArchiveImpl: async (params) => {
            await fs.promises.copyFile(replacementTgz, params.targetPath);
          },
        }),
      ).resolves.toBe(storedPath);

      expect(fs.readFileSync(storedPath)).toEqual(fs.readFileSync(replacementTgz));
      expect(logs[0]).toContain("Replacing stored release package");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the GitHub Packages registry when inventory points at a GitHub package artifact", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-package-registry-test-"));
    const relRoot = path.join(root, "releases");
    const captured: Array<{ packageName: string; registryUrl: string | null | undefined }> = [];

    try {
      await expect(
        ensureStoredReleasePackage({
          relRoot,
          packageName: "openclaw",
          registryPackageName: "@joshuacwebdeveloper/openclaw-polytropos-core",
          version: "2026.6.1-poly.73",
          artifactUrl:
            "https://npm.pkg.github.com/download/@joshuacwebdeveloper/openclaw-polytropos-core/2026.6.1-poly.73/a01eaca8239d83c905e815ff1a78ce3f245811dd",
          env: {},
          stageRegistryPackageArchiveImpl: async (params) => {
            captured.push({
              packageName: params.packageName,
              registryUrl: params.registryUrl,
            });
            await fs.promises.mkdir(path.dirname(params.targetPath), { recursive: true });
            await fs.promises.writeFile(params.targetPath, "packed");
          },
        }),
      ).resolves.toBe(
        resolveStoredReleasePackagePath(relRoot, {
          packageName: "openclaw",
          version: "2026.6.1-poly.73",
        }),
      );

      expect(captured).toEqual([
        {
          packageName: "@joshuacwebdeveloper/openclaw-polytropos-core",
          registryUrl: "https://npm.pkg.github.com",
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the default npm registry for non-GitHub artifact URLs", () => {
    expect(
      resolveReleasePackageRegistryUrl("https://registry.npmjs.org/openclaw/-/openclaw.tgz"),
    ).toBeNull();
  });

  it("passes GitHub Packages auth and registry config to npm pack", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-package-pack-test-"));
    const targetPath = path.join(root, "stored.tgz");
    const calls: Array<{
      args: string[];
      nodeAuthToken: string | undefined;
      userConfig: string | undefined;
      userConfigContent: string;
    }> = [];

    try {
      await stageRegistryPackageArchive({
        packageName: "@joshuacwebdeveloper/openclaw-polytropos-core",
        version: "2026.6.1-poly.73",
        targetPath,
        registryUrl: "https://npm.pkg.github.com",
        env: { GITHUB_TOKEN: "github-package-token" },
        readGhAuthTokenImpl: () => "",
        execFileSyncImpl: (_cmd, args, options) => {
          const packDestination = args[args.indexOf("--pack-destination") + 1];
          fs.writeFileSync(path.join(packDestination, "core.tgz"), "package bytes");
          const userConfig = options.env?.NPM_CONFIG_USERCONFIG;
          calls.push({
            args,
            nodeAuthToken: options.env?.NODE_AUTH_TOKEN,
            userConfig,
            userConfigContent: userConfig ? fs.readFileSync(userConfig, "utf8") : "",
          });
          return "core.tgz\n";
        },
      });

      expect(fs.readFileSync(targetPath, "utf8")).toBe("package bytes");
      expect(calls).toHaveLength(1);
      expect(calls[0].args).toEqual([
        "pack",
        "@joshuacwebdeveloper/openclaw-polytropos-core@2026.6.1-poly.73",
        "--pack-destination",
        expect.any(String),
        "--registry",
        "https://npm.pkg.github.com",
        "--silent",
      ]);
      expect(calls[0].nodeAuthToken).toBe("github-package-token");
      expect(calls[0].userConfigContent).toBe(
        "@joshuacwebdeveloper:registry=https://npm.pkg.github.com\n" +
          "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}\n" +
          "always-auth=true\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("authenticates GitHub Packages artifact downloads", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-package-fetch-test-"));
    const targetPath = path.join(root, "artifact.tgz");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: Readable.toWeb(Readable.from(["artifact bytes"])),
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await downloadArtifactToFile(
        "https://npm.pkg.github.com/download/@joshuacwebdeveloper/openclaw-polytropos-core/2026.6.1-poly.73/a01eaca8239d83c905e815ff1a78ce3f245811dd",
        targetPath,
        {
          env: { GITHUB_TOKEN: "github-package-token" },
          readGhAuthTokenImpl: () => "",
        },
      );

      expect(fs.readFileSync(targetPath, "utf8")).toBe("artifact bytes");
      expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
        headers: {
          authorization: "Bearer github-package-token",
        },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates stored core packages that use the releases/packages naming scheme", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-store-check-test-"));
    const relRoot = path.join(root, "releases");
    const packageRoot = resolvePackageReleaseStoreDir(relRoot);
    fs.mkdirSync(packageRoot, { recursive: true });
    const goodTgz = createTestOpenClawTgz(root, "2026.6.1-poly.71", "good");
    const goodPath = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: "2026.6.1-poly.71",
    });
    fs.copyFileSync(goodTgz, goodPath);

    try {
      expect(() => assertReleaseStoreConsistent(relRoot)).not.toThrow();
      const badTgz = createTestOpenClawTgz(root, "2026.6.2-poly.71", "bad");
      fs.copyFileSync(badTgz, goodPath);
      expect(() => assertReleaseStoreConsistent(relRoot)).toThrow(
        /release store corruption: .*contains version 2026\.6\.2-poly\.71/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stripped base versions in the authoritative releases/packages store", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-store-version-test-"));
    const relRoot = path.join(root, "releases");
    const packageRoot = resolvePackageReleaseStoreDir(relRoot);
    fs.mkdirSync(packageRoot, { recursive: true });
    const strippedTgz = createTestOpenClawTgz(root, "2026.6.1", "stripped");
    const storedPath = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: "2026.6.1-poly.71",
    });
    fs.copyFileSync(strippedTgz, storedPath);

    try {
      expect(() => assertReleaseStoreConsistent(relRoot)).toThrow(
        /release store corruption: .*contains version 2026\.6\.1 \(expected 2026\.6\.1-poly\.71\)/u,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes current and previous compatibility pointers as symlinks into releases/packages", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-pointer-bootstrap-test-"));
    const relRoot = path.join(root, "releases");
    const installedPackage = createTestOpenClawTgz(root, "2026.6.1-poly.73", "current");

    try {
      updateReleasePointers({
        logStream: process.stdout,
        relRoot,
        packagePath: installedPackage,
      });

      const storedPath = resolveStoredReleasePackagePath(relRoot, {
        packageName: "openclaw",
        version: "2026.6.1-poly.73",
      });
      const currentPath = path.join(relRoot, "current.tgz");
      const previousPath = path.join(relRoot, "previous.tgz");

      expect(fs.lstatSync(currentPath).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(previousPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(currentPath)).toBe(storedPath);
      expect(fs.realpathSync(previousPath)).toBe(storedPath);
      expect(fs.readFileSync(storedPath)).toEqual(fs.readFileSync(installedPackage));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy copied current.tgz into a stored previous pointer target", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-pointer-migrate-test-"));
    const relRoot = path.join(root, "releases");
    const packageRoot = resolvePackageReleaseStoreDir(relRoot);
    fs.mkdirSync(packageRoot, { recursive: true });
    const oldPackage = createTestOpenClawTgz(root, "2026.6.1-poly.71", "old");
    const newPackage = createTestOpenClawTgz(root, "2026.6.1-poly.73", "new");
    const oldStoredPath = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: "2026.6.1-poly.71",
    });
    const newStoredPath = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: "2026.6.1-poly.73",
    });
    fs.copyFileSync(oldPackage, oldStoredPath);
    fs.copyFileSync(oldPackage, path.join(relRoot, "current.tgz"));

    try {
      updateReleasePointers({
        logStream: process.stdout,
        relRoot,
        packagePath: newPackage,
      });

      const currentPath = path.join(relRoot, "current.tgz");
      const previousPath = path.join(relRoot, "previous.tgz");

      expect(fs.lstatSync(currentPath).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(previousPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(currentPath)).toBe(newStoredPath);
      expect(fs.realpathSync(previousPath)).toBe(oldStoredPath);
      expect(fs.readFileSync(newStoredPath)).toEqual(fs.readFileSync(newPackage));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the core install package from authoritative inventory metadata", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-release-store-test-"));
    const relRoot = path.join(root, "releases");
    const releaseTag = "v2026.6.1-poly.71";
    const expectedVersion = "2026.6.1-poly.71";
    const inventoryPath = path.join(relRoot, `${releaseTag}.json`);
    const localCorePackage = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: expectedVersion,
    });
    fs.mkdirSync(path.dirname(localCorePackage), { recursive: true });
    fs.copyFileSync(createTestOpenClawTgz(root, expectedVersion, "cached"), localCorePackage);
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          packages: [
            {
              packageName: "openclaw",
              packageType: "core",
              latestVersion: expectedVersion,
              integrity: "sha512-test",
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      expect(resolveReleaseCoreInstallPackagePath({ relRoot, releaseTag })).toBe(localCorePackage);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps legacy package-inventory filenames readable for existing staged releases", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-release-legacy-test-"));
    const relRoot = path.join(root, "releases");
    const releaseTag = "v2026.6.1-poly.72";
    const expectedVersion = "2026.6.1-poly.72";
    const inventoryPath = path.join(relRoot, `${releaseTag}.package-inventory.json`);
    const localCorePackage = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: expectedVersion,
    });
    fs.mkdirSync(path.dirname(localCorePackage), { recursive: true });
    fs.copyFileSync(createTestOpenClawTgz(root, expectedVersion, "cached"), localCorePackage);
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          packages: [
            {
              packageName: "openclaw",
              packageType: "core",
              latestVersion: expectedVersion,
              integrity: "sha512-test",
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      expect(resolveReleaseCoreInstallPackagePath({ relRoot, releaseTag })).toBe(localCorePackage);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a package inventory json file as an install input", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-install-input-test-"));
    const relRoot = path.join(root, "releases");
    const releaseTag = "v2026.6.1-poly.73";
    const expectedVersion = "2026.6.1-poly.73";
    const inventoryPath = path.join(relRoot, `${releaseTag}.json`);
    const localCorePackage = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: expectedVersion,
    });
    fs.mkdirSync(path.dirname(localCorePackage), { recursive: true });
    fs.copyFileSync(createTestOpenClawTgz(root, expectedVersion, "cached"), localCorePackage);
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          releaseTag,
          packages: [
            {
              packageName: "openclaw",
              packageType: "core",
              latestVersion: expectedVersion,
              integrity: "sha512-test",
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      expect(resolveInstallPackageInput(inventoryPath)).toEqual({
        packagePath: localCorePackage,
        releaseTag,
        inventoryPath,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrates the staged core package when an inventory install input is missing it locally", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-install-hydrate-test-"));
    const relRoot = path.join(root, "releases");
    const releaseTag = "v2026.6.1-poly.71";
    const expectedVersion = "2026.6.1-poly.71";
    const inventoryPath = path.join(relRoot, `${releaseTag}.package-inventory.json`);
    const localCorePackage = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: expectedVersion,
    });
    const replacementTgz = createTestPackageTgz(
      root,
      "@joshuacwebdeveloper/openclaw-polytropos-core",
      expectedVersion,
      "replacement",
    );
    fs.mkdirSync(relRoot, { recursive: true });
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          releaseTag,
          packages: [
            {
              packageName: "openclaw",
              publishedPackageName: "@joshuacwebdeveloper/openclaw-polytropos-core",
              packageType: "core",
              latestVersion: expectedVersion,
              artifactUrl:
                "https://npm.pkg.github.com/download/@joshuacwebdeveloper/openclaw-polytropos-core/2026.6.1-poly.71/archive",
              integrity: "sha512-test",
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      await expect(
        prepareInstallPackageInput(inventoryPath, {
          ensureStoredReleasePackageImpl: async (params) => {
            expect(params.relRoot).toBe(relRoot);
            expect(params.packageName).toBe("openclaw");
            expect(params.registryPackageName).toBe(
              "@joshuacwebdeveloper/openclaw-polytropos-core",
            );
            expect(params.version).toBe(expectedVersion);
            await fs.promises.mkdir(path.dirname(localCorePackage), { recursive: true });
            await fs.promises.copyFile(replacementTgz, localCorePackage);
            return localCorePackage;
          },
        }),
      ).resolves.toEqual({
        packagePath: localCorePackage,
        releaseTag,
        inventoryPath,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects inventory installs when the cached core package contents do not match the inventory version", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-install-corrupt-test-"));
    const relRoot = path.join(root, "releases");
    const releaseTag = "v2026.6.1-poly.71";
    const inventoryPath = path.join(relRoot, `${releaseTag}.json`);
    const localCorePackage = resolveStoredReleasePackagePath(relRoot, {
      packageName: "openclaw",
      version: "2026.6.1-poly.71",
    });
    fs.mkdirSync(path.dirname(localCorePackage), { recursive: true });
    fs.copyFileSync(createTestOpenClawTgz(root, "2026.6.1", "corrupt"), localCorePackage);
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          releaseTag,
          packages: [
            {
              packageName: "openclaw",
              packageType: "core",
              latestVersion: "2026.6.1-poly.71",
              integrity: "sha512-test",
            },
          ],
        },
        null,
        2,
      ),
    );

    try {
      expect(() => resolveInstallPackageInput(inventoryPath)).toThrow(
        /contains version 2026\.6\.1 \(expected 2026\.6\.1-poly\.71\)/u,
      );
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

  it("creates a legacy openclaw package alias after installing the scoped core package", () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-legacy-alias-test-"));
    const npmRoot = path.join(root, "lib", "node_modules");
    const installedRoot = path.join(npmRoot, "@joshuacwebdeveloper", "openclaw-polytropos-core");
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.writeFileSync(
      path.join(installedRoot, "package.json"),
      JSON.stringify({
        name: "@joshuacwebdeveloper/openclaw-polytropos-core",
        version: "2026.6.1-poly.73",
      }),
    );

    try {
      const aliasPath = ensureLegacyOpenClawPackageAlias({
        npmRoot,
        packageName: "@joshuacwebdeveloper/openclaw-polytropos-core",
        logStream: process.stdout,
      });
      expect(aliasPath).toBe(path.join(npmRoot, "openclaw"));
      expect(fs.lstatSync(aliasPath).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(aliasPath)).toBe(fs.realpathSync(installedRoot));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it("repairs managed npm openclaw peer links even when no plugin version changed", async () => {
    const root = fs.mkdtempSync(path.join("/tmp", "openclaw-polytropos-peer-link-test-"));
    const hostRoot = path.join(root, "host-openclaw");
    const installPath = path.join(root, "projects", "demo", "node_modules", "@openclaw", "codex");
    fs.mkdirSync(path.join(hostRoot, "dist", "plugin-sdk"), { recursive: true });
    fs.writeFileSync(
      path.join(hostRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.6.1-poly.73" }, null, 2),
    );
    fs.writeFileSync(
      path.join(hostRoot, "dist", "plugin-sdk", "number-runtime.js"),
      "export const value = 1;\n",
    );
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/codex",
          version: "2026.6.1",
          peerDependencies: { openclaw: ">=2026.6.1" },
        },
        null,
        2,
      ),
    );
    const staleHostRoot = path.join(root, "source-openclaw");
    fs.mkdirSync(path.join(staleHostRoot, "dist", "plugin-sdk"), { recursive: true });
    fs.writeFileSync(
      path.join(staleHostRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.6.1" }, null, 2),
    );
    fs.mkdirSync(path.join(installPath, "node_modules"), { recursive: true });
    fs.symlinkSync(staleHostRoot, path.join(installPath, "node_modules", "openclaw"), "junction");
    const logs: string[] = [];

    try {
      const summary = await repairOpenClawPeerLinksForReleaseInstall({
        hostRoot,
        installRecords: {
          codex: {
            source: "npm",
            spec: "@openclaw/codex@2026.6.1",
            installPath,
            version: "2026.6.1",
          },
        },
        logger: {
          info: (message) => logs.push(message),
          warn: (message) => logs.push(message),
        },
      });

      expect(summary).toEqual({ checked: 1, attempted: 1, repaired: 1, skipped: 0 });
      const linkedPackage = path.join(installPath, "node_modules", "openclaw", "package.json");
      expect(fs.realpathSync(path.dirname(linkedPackage))).toBe(fs.realpathSync(hostRoot));
      expect(logs).toContain(`Linked peerDependency "openclaw" -> ${hostRoot}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
