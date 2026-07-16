import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

type PolytroposLauncherModule = {
  loadPolytroposCliClaims: (options?: {
    roots?: string[];
    env?: Record<string, string | undefined>;
    workspaceDir?: string;
  }) => Promise<PolytroposCliClaim[]>;
  resolvePolytroposPluginRoots: (env?: Record<string, string | undefined>) => string[];
  dispatchPolytroposCliClaim: (claim: PolytroposCliClaim, argv: string[]) => Promise<number>;
  runPolytroposLauncher: (argv: string[]) => Promise<boolean>;
  resolvePolytroposCliClaim: (
    argv: string[],
    claims?: PolytroposCliClaim[],
  ) => PolytroposCliClaim | null;
  runCoreLauncher: (
    argv: string[],
    deps?: {
      spawn?: typeof spawn;
      stdout?: { isTTY?: boolean; write: (chunk: Buffer | string) => void };
      stderr?: { isTTY?: boolean; write: (chunk: Buffer | string) => void };
      env?: Record<string, string | undefined>;
    },
  ) => Promise<number>;
};

type PolytroposCliClaim = {
  pluginId: string;
  commandPath: string[];
  parentPath: string[];
  command: string;
  registrar: ((ctx: { program: PluginCommandRecorder }) => void | Promise<void>) | null;
  source?: string;
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
    delete process.env.OPENCLAW_POLYTROPOS_CLI_LOG_PATH;
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
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: `@openclaw/${id}`,
        openclaw: { extensions: ["./dist/index.mjs"] },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({ id }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pluginRoot, "cli-metadata.mjs"),
      [
        "export default {",
        "  register(api) {",
        "    api.registerCli(() => {}, {",
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

  function loadCliClaims(
    options: NonNullable<Parameters<PolytroposLauncherModule["loadPolytroposCliClaims"]>[0]> = {},
  ) {
    return launcher.loadPolytroposCliClaims(options);
  }

  it.runIf(process.platform !== "win32")(
    "discovers a symlinked plugin from the default extensions root",
    async () => {
      const sourceExtensionsRoot = await writePluginFixture();
      const sourcePluginRoot = path.join(sourceExtensionsRoot, "polytropos-cli");
      const stateDir = makeTempDir(fixtureRoots, "polytropos-state-");
      const extensionsRoot = path.join(stateDir, "extensions");
      await fs.mkdir(extensionsRoot, { recursive: true });
      await fs.symlink(sourcePluginRoot, path.join(extensionsRoot, "polytropos-cli"), "dir");

      const claims = await loadCliClaims({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });

      expect(claims).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: "polytropos-cli",
            commandPath: ["hooks", "relay"],
          }),
        ]),
      );
    },
  );

  it("keeps global plugin discovery when explicit Polytropos roots are present", async () => {
    const explicitRoot = await writePluginFixture({ id: "explicit-cli", command: "explicit" });
    const globalFixtureRoot = await writePluginFixture({ id: "global-cli", command: "global" });
    const stateDir = makeTempDir(fixtureRoots, "polytropos-state-");
    const extensionsRoot = path.join(stateDir, "extensions");
    await fs.mkdir(extensionsRoot, { recursive: true });
    await fs.rename(
      path.join(globalFixtureRoot, "polytropos-cli"),
      path.join(extensionsRoot, "global-cli"),
    );

    const claims = await loadCliClaims({
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS: explicitRoot,
      },
    });

    expect(claims.map((claim) => claim.commandPath)).toEqual(
      expect.arrayContaining([
        ["hooks", "explicit"],
        ["hooks", "global"],
      ]),
    );
  });

  it("loads a plugin-owned claim for the plugin command path", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await loadCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay", "--provider", "codex"],
      claims,
    );

    expect(claim?.pluginId).toBe("polytropos-cli");
    expect(claim?.commandPath).toEqual(["hooks", "relay"]);
  });

  it("does not import full plugin entries while discovering CLI claims", async () => {
    const extensionsRoot = await writePluginFixture();
    const marker = path.join(extensionsRoot, "full-entry-loaded.txt");
    const pluginSource = path.join(extensionsRoot, "polytropos-cli", "dist", "index.mjs");
    const currentSource = await fs.readFile(pluginSource, "utf8");
    await fs.writeFile(
      pluginSource,
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'loaded');`,
        currentSource,
      ].join("\n"),
      "utf8",
    );

    const claims = await loadCliClaims({ roots: [extensionsRoot] });

    expect(claims.map((claim) => claim.commandPath)).toContainEqual(["hooks", "relay"]);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discovers plugin CLI claims for arbitrary command paths", async () => {
    const extensionsRoot = await writePluginFixture({
      parentPath: ["tools"],
      command: "inspect",
    });
    const claims = await loadCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "tools", "inspect"],
      claims,
    );

    expect(claim?.pluginId).toBe("polytropos-cli");
    expect(claim?.commandPath).toEqual(["tools", "inspect"]);
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

  it("passes piped core launcher output through before the child exits", async () => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    child.stdout = new EventEmitter() as ReturnType<typeof spawn>["stdout"];
    child.stderr = new EventEmitter() as ReturnType<typeof spawn>["stderr"];
    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    const spawnCalls: unknown[] = [];

    const exitCodePromise = launcher.runCoreLauncher(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "logs", "--follow"],
      {
        spawn: ((...args: unknown[]) => {
          spawnCalls.push(args);
          return child;
        }) as typeof spawn,
        stdout: {
          isTTY: false,
          write: (chunk) => {
            stdoutWrites.push(String(chunk));
          },
        },
        stderr: {
          isTTY: false,
          write: (chunk) => {
            stderrWrites.push(String(chunk));
          },
        },
      },
    );

    child.stdout.emit("data", Buffer.from("openclaw child started\n"));
    child.stderr.emit("data", Buffer.from("openclaw child stderr\n"));

    expect(stdoutWrites).toEqual(["openclaw child started\n"]);
    expect(stderrWrites).toEqual(["openclaw child stderr\n"]);
    expect(spawnCalls[0]).toMatchObject([
      process.execPath,
      [expect.stringContaining("openclaw.mjs"), "logs", "--follow"],
      { stdio: ["inherit", "pipe", "pipe"] },
    ]);

    child.emit("close", 0, null);
    await expect(exitCodePromise).resolves.toBe(0);
  });

  it("preserves TTY stdio for the core launcher fallback", async () => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const spawnCalls: unknown[] = [];

    const exitCodePromise = launcher.runCoreLauncher(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "logs", "--follow"],
      {
        spawn: ((...args: unknown[]) => {
          spawnCalls.push(args);
          return child;
        }) as typeof spawn,
        stdout: { isTTY: true, write: () => {} },
        stderr: { isTTY: true, write: () => {} },
      },
    );
    child.emit("close", 0, null);

    await expect(exitCodePromise).resolves.toBe(0);
    expect(spawnCalls[0]).toMatchObject([
      process.execPath,
      [expect.stringContaining("openclaw.mjs"), "logs", "--follow"],
      { stdio: ["inherit", "inherit", "inherit"] },
    ]);
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
    const claims = await loadCliClaims({ roots: [extensionsRoot] });
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

  it("emits debug proof from the plugin-owned claim path when enabled", async () => {
    const extensionsRoot = await writePluginFixture();
    const previousRoots = process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
    const previousDebug = process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG;
    let stderr = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = extensionsRoot;
    process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG = "1";
    try {
      await launcher.runPolytroposLauncher([
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
      ]);
    } finally {
      process.stderr.write = originalWrite;
      if (previousRoots === undefined) {
        delete process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
      } else {
        process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = previousRoots;
      }
      if (previousDebug === undefined) {
        delete process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG;
      } else {
        process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG = previousDebug;
      }
    }

    expect(process.exitCode).toBe(17);
    expect(stderr).toContain(
      "[polytropos cli] dispatching plugin CLI claim plugin=polytropos-cli command=hooks relay",
    );
    expect(stderr).toContain(
      "[polytropos cli] plugin CLI claim completed plugin=polytropos-cli command=hooks relay exitCode=17",
    );
  });

  it("renders claimed command help before required option validation", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await loadCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay"],
      claims,
    );

    expect(claim).not.toBeNull();
    let stdout = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      const exitCode = await launcher.dispatchPolytroposCliClaim(claim!, [
        "/usr/bin/node",
        "/opt/openclaw/polytropos.mjs",
        "hooks",
        "relay",
        "--help",
      ]);

      expect(exitCode).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(stdout).toContain("Usage: openclaw hooks relay [options]");
    expect(stdout).toContain("Internal native harness hook relay");
    expect(stdout).toContain("--provider <provider>");
    expect(stdout).toContain("--relay-id <id>");
    expect(
      (globalThis as { __polytroposDispatchOptions?: unknown }).__polytroposDispatchOptions,
    ).toBeUndefined();
  });

  it("keeps claimed relay help on the core terminal color path", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await loadCliClaims({ roots: [extensionsRoot] });
    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay", "--help"],
      claims,
    );
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    let stdout = "";
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    try {
      const exitCode = await launcher.dispatchPolytroposCliClaim(claim!, [
        "/usr/bin/node",
        "/opt/openclaw/polytropos.mjs",
        "hooks",
        "relay",
        "--help",
      ]);

      expect(exitCode).toBe(0);
    } finally {
      process.stdout.write = originalWrite;
      if (previousForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = previousForceColor;
      }
      if (previousNoColor === undefined) {
        delete process.env.NO_COLOR;
      } else {
        process.env.NO_COLOR = previousNoColor;
      }
    }

    const plainStdout = stdout.replace(/\u001b\[[0-9;]*m/gu, "");
    const { theme } = await import("../packages/terminal-core/src/theme.js");
    expect(stdout).toContain(theme.heading("Usage:"));
    expect(stdout).toContain(theme.option("--relay-id <id>"));
    expect(plainStdout).toContain("Usage: openclaw hooks relay [options]");
    expect(plainStdout).toContain("--relay-id <id>");
  });

  it("records claimed relay probe help in gateway-visible logs without stderr proof markers", async () => {
    const extensionsRoot = await writePluginFixture();
    const previousRoots = process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
    const previousDebug = process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG;
    const logPath = path.join(makeTempDir(fixtureRoots, "polytropos-gateway-log-"), "gateway.log");
    let stderr = "";
    const originalStdoutWrite = process.stdout.write;
    const originalWrite = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = extensionsRoot;
    process.env.OPENCLAW_POLYTROPOS_CLI_LOG_PATH = logPath;
    delete process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG;
    try {
      await launcher.runPolytroposLauncher([
        "/usr/bin/node",
        "/opt/openclaw/polytropos.mjs",
        "hooks",
        "relay",
        "--help",
      ]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalWrite;
      if (previousRoots === undefined) {
        delete process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
      } else {
        process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = previousRoots;
      }
      if (previousDebug === undefined) {
        delete process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG;
      } else {
        process.env.OPENCLAW_POLYTROPOS_CLI_DEBUG = previousDebug;
      }
    }

    const logText = await fs.readFile(logPath, "utf8");
    const records = logText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "claimed hooks relay probe",
          time: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u,
          ),
          hostname: expect.any(String),
          _meta: expect.objectContaining({
            hostname: expect.any(String),
            logLevelName: "INFO",
          }),
          "0": expect.objectContaining({
            command: "openclaw hooks relay --help",
            plugin: "polytropos-cli",
            exitCode: 0,
          }),
        }),
      ]),
    );
    expect(stderr).not.toContain("[polytropos cli]");
  });

  it("does not load the full plugin SDK runtime for relay probe logging", async () => {
    const launcherSource = await fs.readFile(path.resolve(process.cwd(), "polytropos.mjs"), "utf8");

    expect(launcherSource).not.toContain("./dist/plugin-sdk/runtime.js");
    expect(launcherSource).not.toContain("./dist/logging/logger.js");
    expect(launcherSource).not.toContain("./src/logging.ts");
    expect(launcherSource).not.toContain("./src/logging/logger.ts");
    expect(launcherSource).toContain("./src/logging/file-log-record.ts");
  });

  it("records claimed relay validation fallback in gateway-visible logs", async () => {
    const extensionsRoot = await writePluginFixture();
    const previousRoots = process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
    const logPath = path.join(makeTempDir(fixtureRoots, "polytropos-gateway-log-"), "gateway.log");
    const originalWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = extensionsRoot;
    process.env.OPENCLAW_POLYTROPOS_CLI_LOG_PATH = logPath;
    try {
      await launcher.runPolytroposLauncher([
        "/usr/bin/node",
        "/opt/openclaw/polytropos.mjs",
        "hooks",
        "relay",
      ]);
    } finally {
      process.stderr.write = originalWrite;
      if (previousRoots === undefined) {
        delete process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
      } else {
        process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = previousRoots;
      }
    }

    const logText = await fs.readFile(logPath, "utf8");
    const records = logText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(process.exitCode).toBe(1);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "claimed hooks relay probe",
          time: expect.stringMatching(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/u,
          ),
          hostname: expect.any(String),
          _meta: expect.objectContaining({
            hostname: expect.any(String),
            logLevelName: "INFO",
          }),
          "0": expect.objectContaining({
            command: "openclaw hooks relay",
            plugin: "polytropos-cli",
            exitCode: 1,
          }),
        }),
      ]),
    );
  });

  it("reports claimed command option failures from the launcher path", async () => {
    const extensionsRoot = await writePluginFixture();
    const previousRoots = process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
    let stderr = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    }) as typeof process.stderr.write;
    process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = extensionsRoot;
    try {
      await launcher.runPolytroposLauncher([
        "/usr/bin/node",
        "/opt/openclaw/polytropos.mjs",
        "hooks",
        "relay",
        "--provider",
        "codex",
        "--event",
        "pre_tool_use",
      ]);
    } finally {
      process.stderr.write = originalWrite;
      if (previousRoots === undefined) {
        delete process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS;
      } else {
        process.env.OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS = previousRoots;
      }
    }

    expect(process.exitCode).toBe(1);
    expect(stderr).toContain(
      "polytropos launcher: Missing required plugin CLI argument: --relay-id",
    );
    expect(
      (globalThis as { __polytroposDispatchOptions?: unknown }).__polytroposDispatchOptions,
    ).toBeUndefined();
  });

  it("applies plugin option defaults during dispatch", async () => {
    const extensionsRoot = await writePluginFixture();
    const claims = await loadCliClaims({ roots: [extensionsRoot] });
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
