import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

async function makeLauncherFixture(fixtureRoots: string[]): Promise<string> {
  const fixtureRoot = makeTempDir(fixtureRoots, "polytropos-launcher-");
  await Promise.all([
    fs.copyFile(
      path.resolve(process.cwd(), "polytropos.mjs"),
      path.join(fixtureRoot, "polytropos.mjs"),
    ),
    fs.copyFile(
      path.resolve(process.cwd(), "openclaw.mjs"),
      path.join(fixtureRoot, "openclaw.mjs"),
    ),
    fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true }),
  ]);
  return fixtureRoot;
}

describe("polytropos launcher", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    cleanupTempDirs(fixtureRoots);
  });

  it("adds the fork identity before the normal OpenClaw version output", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.2.3-test",
        gitHead: "abcdef0123456789",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "throw new Error('runtime entry should not load for --version');\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "polytropos.mjs"), "--version"],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Polytropos CLI (OpenClaw fork)\nOpenClaw 1.2.3-test (abcdef0)\n");
    expect(result.stderr).toBe("");
  });

  it("forwards command arguments unchanged to the OpenClaw entry", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);\n",
      "utf8",
    );
    const args = ["status", "--json", "--profile", "fork-test"];

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "polytropos.mjs"), ...args],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify(args)}\n`);
    expect(result.stderr).toBe("");
  });

  it("routes native hook relay directly to the lightweight relay entry", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.mkdir(path.join(fixtureRoot, "dist", "cli"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "throw new Error('normal CLI entry should not load for hooks relay');\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "cli", "native-hook-relay-cli.js"),
      [
        "export async function runNativeHookRelayCli(options) {",
        "  process.stdout.write(`${JSON.stringify(options)}\\n`);",
        "  return 0;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(fixtureRoot, "polytropos.mjs"),
        "hooks",
        "relay",
        "--provider",
        "codex",
        "--relay-id",
        "relay-1",
        "--generation",
        "generation-1",
        "--event",
        "pre_tool_use",
        "--pre-tool-use-unavailable",
        "noop",
        "--timeout",
        "5000",
      ],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      preToolUseUnavailable: "noop",
      timeout: "5000",
    });
    expect(result.stderr).toBe("");
  });

  it("does not intercept subcommand version flags", async () => {
    const fixtureRoot = await makeLauncherFixture(fixtureRoots);
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "entry.js"),
      "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);\n",
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(fixtureRoot, "polytropos.mjs"), "nodes", "--version"],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('["nodes","--version"]\n');
    expect(result.stderr).toBe("");
  });
});
