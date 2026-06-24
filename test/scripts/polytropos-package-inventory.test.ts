import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("resolvePublishedVersionState", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("node:child_process");
  });

  it("uses the latest published version as both base and latest when no package was published in the current release", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: (_command: string, args: string[]) => {
        if (args[2] === "versions") {
          return JSON.stringify(["2026.6.1-poly.74", "2026.6.1-poly.75"]);
        }
        return JSON.stringify({
          version: "2026.6.1-poly.75",
          dist: {
            tarball: "https://example.test/openclaw-codex-2026.6.1-poly.75.tgz",
            integrity: "sha512-unchanged",
          },
        });
      },
    }));

    const { resolvePublishedVersionState } = await importFreshModule<
      typeof import("../../scripts/polytropos-package-inventory.ts")
    >(import.meta.url, "../../scripts/polytropos-package-inventory.ts?unchanged");

    expect(
      resolvePublishedVersionState({
        publishedPackageName: "@openclaw/codex",
        currentReleaseVersion: "2026.6.1-poly.77",
        packageRegistryUrl: "https://npm.pkg.github.com",
      }),
    ).toMatchObject({
      baseVersion: "2026.6.1-poly.75",
      latestVersion: "2026.6.1-poly.75",
      publishedInRun: false,
      artifactUrl: "https://example.test/openclaw-codex-2026.6.1-poly.75.tgz",
      integrity: "sha512-unchanged",
    });
  });

  it("uses the previous published version as base when the current release published a new package", async () => {
    vi.doMock("node:child_process", () => ({
      execFileSync: (_command: string, args: string[]) => {
        if (args[2] === "versions") {
          return JSON.stringify(["2026.6.1-poly.74", "2026.6.1-poly.75", "2026.6.1-poly.77"]);
        }
        return JSON.stringify({
          version: "2026.6.1-poly.77",
          dist: {
            tarball: "https://example.test/openclaw-codex-2026.6.1-poly.77.tgz",
            integrity: "sha512-changed",
          },
        });
      },
    }));

    const { resolvePublishedVersionState } = await importFreshModule<
      typeof import("../../scripts/polytropos-package-inventory.ts")
    >(import.meta.url, "../../scripts/polytropos-package-inventory.ts?changed");

    expect(
      resolvePublishedVersionState({
        publishedPackageName: "@openclaw/codex",
        currentReleaseVersion: "2026.6.1-poly.77",
        packageRegistryUrl: "https://npm.pkg.github.com",
      }),
    ).toMatchObject({
      baseVersion: "2026.6.1-poly.75",
      latestVersion: "2026.6.1-poly.77",
      publishedInRun: true,
      artifactUrl: "https://example.test/openclaw-codex-2026.6.1-poly.77.tgz",
      integrity: "sha512-changed",
    });
  });
});
