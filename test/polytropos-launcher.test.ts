import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

type PolytroposLauncherModule = {
  loadPolytroposCliClaims: (options?: { roots?: string[] }) => Promise<PolytroposCliClaim[]>;
  resolvePolytroposPluginRoots: (env?: Record<string, string | undefined>) => string[];
  dispatchPolytroposCliClaim: (claim: PolytroposCliClaim, argv: string[]) => Promise<number>;
  resolvePolytroposCliClaim: (
    argv: string[],
    claims?: PolytroposCliClaim[],
  ) => PolytroposCliClaim | null;
};

type PolytroposCliClaim = {
  pluginId: string;
  commandPath: string[];
  parentPath: string[];
  command: string;
  registrar: (ctx: { program: PluginCommandRecorder }) => void | Promise<void>;
};

type PluginCommandRecorder = {
  command(name: string, opts?: { hidden?: boolean }): PluginCommandRecorder;
  description(text: string): PluginCommandRecorder;
  requiredOption(flags: string, description: string): PluginCommandRecorder;
  option(flags: string, description: string, defaultValue?: string): PluginCommandRecorder;
  action(handler: (opts: Record<string, string>) => void | Promise<void>): PluginCommandRecorder;
};

let launcher: PolytroposLauncherModule;

async function importLauncher(): Promise<PolytroposLauncherModule> {
  return (await import(
    pathToFileURL(path.resolve(process.cwd(), "polytropos.mjs")).href
  )) as PolytroposLauncherModule;
}

describe("polytropos launcher claims", () => {
  const fixtureRoots: string[] = [];

  beforeAll(async () => {
    launcher = await importLauncher();
  });

  afterEach(() => {
    cleanupTempDirs(fixtureRoots);
    delete (globalThis as { __polytroposDispatchOptions?: unknown }).__polytroposDispatchOptions;
    process.exitCode = undefined;
  });

  async function writePluginFixture(
    params: {
      id?: string;
      rootName?: string;
      parentPath?: string[];
      command?: string;
      actionExitCode?: number;
    } = {},
  ) {
    const extensionsRoot = makeTempDir(fixtureRoots, "polytropos-extensions-");
    const pluginRoot = path.join(extensionsRoot, params.rootName ?? "polytropos-cli");
    const manifestRoot = path.join(pluginRoot, "dist");
    await fs.mkdir(manifestRoot, { recursive: true });
    const id = params.id ?? "polytropos-cli";
    await fs.writeFile(
      path.join(manifestRoot, "openclaw.plugin.json"),
      JSON.stringify({ id, entry: "index.mjs" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(manifestRoot, "index.mjs"),
      [
        "export default {",
        "  register(api) {",
        "    api.registerCli(({ program }) => {",
        `      program.command(${JSON.stringify(params.command ?? "relay")}, { hidden: true })`,
        "        .description('Internal native harness hook relay')",
        "        .requiredOption('--provider <provider>', 'Native harness provider')",
        "        .requiredOption('--relay-id <id>', 'Native hook relay id')",
        "        .option('--generation <generation>', 'Native hook relay registration generation')",
        "        .requiredOption('--event <event>', 'Native hook event')",
        "        .option('--pre-tool-use-unavailable <mode>', 'PreToolUse fallback mode')",
        "        .option('--timeout <ms>', 'Gateway timeout in ms', '5000')",
        "        .action(async (opts) => {",
        "          globalThis.__polytroposDispatchOptions = opts;",
        `          process.exitCode = ${params.actionExitCode ?? 17};`,
        "        });",
        "    }, {",
        `      parentPath: ${JSON.stringify(params.parentPath ?? ["hooks"])},`,
        `      commands: [${JSON.stringify(params.command ?? "relay")}],`,
        "      descriptors: [{",
        `        name: ${JSON.stringify(params.command ?? "relay")},`,
        "        description: 'Internal native harness hook relay',",
        "        hasSubcommands: false,",
        "      }],",
        "    });",
        "  },",
        "};",
      ].join("\n"),
      "utf8",
    );
    return extensionsRoot;
  }

  it("loads a plugin-owned claim for the plugin command path", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await launcher.loadPolytroposCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay", "--provider", "codex"],
      claims,
    );

    expect(claim?.pluginId).toBe("polytropos-cli");
    expect(claim?.commandPath).toEqual(["hooks", "relay"]);
  });

  it("falls back when only a sibling command path is present", () => {
    expect(
      launcher.resolvePolytroposCliClaim([
        "/usr/bin/node",
        "/opt/openclaw/polytropos.mjs",
        "hooks",
        "status",
        "--json",
      ]),
    ).toBeNull();
  });

  it("falls back to the core launcher for --version", () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), "polytropos.mjs"), "--version"],
      {
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^OpenClaw 2026\.6\.2/);
  });

  it("falls back to the core launcher for unclaimed root invocations", () => {
    const result = spawnSync(process.execPath, [path.resolve(process.cwd(), "polytropos.mjs")], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing dist/entry.(m)js");
  });

  it("resolves installed plugin roots from the active state dir", () => {
    expect(
      launcher.resolvePolytroposPluginRoots({
        OPENCLAW_STATE_DIR: "/tmp/openclaw-state",
      }),
    ).toEqual([path.join("/tmp/openclaw-state", "extensions")]);
  });

  it.runIf(process.platform !== "win32")(
    "runs when invoked through an npm-style symlink",
    async () => {
      const binRoot = makeTempDir(fixtureRoots, "polytropos-bin-");
      const launcherPath = path.resolve(process.cwd(), "polytropos.mjs");
      const linkedLauncherPath = path.join(binRoot, "openclaw");
      await fs.symlink(launcherPath, linkedLauncherPath);

      expect(execFileSync(linkedLauncherPath, ["--version"], { encoding: "utf8" })).toMatch(
        /^OpenClaw 2026\.6\.2/,
      );
    },
  );

  it("selects the longest matching claim", () => {
    const claims = [
      {
        pluginId: "root-hooks",
        commandPath: ["hooks"],
        parentPath: [],
        command: "hooks",
        registrar: () => {},
      },
      {
        pluginId: "relay-hooks",
        commandPath: ["hooks", "relay"],
        parentPath: ["hooks"],
        command: "relay",
        registrar: () => {},
      },
    ];

    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay"],
      claims,
    );

    expect(claim?.pluginId).toBe("relay-hooks");
  });

  it("dispatches a claimed path through its plugin registrar action", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await launcher.loadPolytroposCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay"],
      claims,
    );

    expect(claim).not.toBeNull();
    const exitCode = await launcher.dispatchPolytroposCliClaim(claim!, [
      "/usr/bin/node",
      "/opt/openclaw/polytropos.mjs",
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
      "6000",
    ]);

    expect(exitCode).toBe(17);
    expect(
      (globalThis as { __polytroposDispatchOptions?: unknown }).__polytroposDispatchOptions,
    ).toEqual({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      preToolUseUnavailable: "noop",
      timeout: "6000",
    });
  });

  it("applies plugin option defaults during dispatch", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await launcher.loadPolytroposCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay"],
      claims,
    );

    expect(claim).not.toBeNull();
    await launcher.dispatchPolytroposCliClaim(claim!, [
      "/usr/bin/node",
      "/opt/openclaw/polytropos.mjs",
      "hooks",
      "relay",
      "--provider",
      "codex",
      "--relay-id",
      "relay-1",
      "--event",
      "permission_request",
    ]);

    expect(
      (globalThis as { __polytroposDispatchOptions?: unknown }).__polytroposDispatchOptions,
    ).toMatchObject({ timeout: "5000" });
  });
});
