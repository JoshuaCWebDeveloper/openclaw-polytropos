import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

type PolytroposLauncherModule = {
  DEFAULT_POLYTROPOS_CLI_CLAIMS: Array<{
    pluginId: string;
    commandPath: string[];
    module: string;
    exportName: string;
    parseOptions: (argv: string[], startIndex: number) => unknown;
  }>;
  dispatchPolytroposCliClaim: (
    claim: {
      pluginId: string;
      commandPath: string[];
      module: string;
      exportName: string;
      parseOptions: (argv: string[], startIndex: number) => unknown;
    },
    argv: string[],
  ) => Promise<number>;
  parseNativeHookRelayOptions: (argv: string[], startIndex: number) => Record<string, string>;
  resolvePolytroposCliClaim: (
    argv: string[],
    claims?: Array<{
      pluginId: string;
      commandPath: string[];
      module: string;
      exportName: string;
      parseOptions: (argv: string[], startIndex: number) => unknown;
    }>,
  ) => {
    pluginId: string;
    commandPath: string[];
    module: string;
    exportName: string;
    parseOptions: (argv: string[], startIndex: number) => unknown;
  } | null;
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
  });

  it("claims the configured plugin command path", () => {
    const claim = launcher.resolvePolytroposCliClaim([
      "/usr/bin/node",
      "/opt/openclaw/polytropos.mjs",
      "hooks",
      "relay",
      "--provider",
      "codex",
    ]);

    expect(claim?.pluginId).toBe("polytropos-codex");
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

  it("selects the longest matching claim", () => {
    const claims = [
      {
        pluginId: "root-hooks",
        commandPath: ["hooks"],
        module: "unused",
        exportName: "unused",
        parseOptions: () => ({}),
      },
      {
        pluginId: "relay-hooks",
        commandPath: ["hooks", "relay"],
        module: "unused",
        exportName: "unused",
        parseOptions: () => ({}),
      },
    ];

    const claim = launcher.resolvePolytroposCliClaim(
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "hooks", "relay"],
      claims,
    );

    expect(claim?.pluginId).toBe("relay-hooks");
  });

  it("parses native hook relay options for the claimed handler", () => {
    expect(
      launcher.parseNativeHookRelayOptions(
        [
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
          "5000",
        ],
        4,
      ),
    ).toEqual({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      preToolUseUnavailable: "noop",
      timeout: "5000",
    });
  });

  it("dispatches a claimed path through its plugin handler", async () => {
    const fixtureRoot = makeTempDir(fixtureRoots, "polytropos-claim-");
    const handlerPath = path.join(fixtureRoot, "handler.mjs");
    await fs.writeFile(
      handlerPath,
      [
        "export async function run(options) {",
        "  globalThis.__polytroposDispatchOptions = options;",
        "  return 17;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const exitCode = await launcher.dispatchPolytroposCliClaim(
      {
        pluginId: "test-plugin",
        commandPath: ["test", "claim"],
        module: pathToFileURL(handlerPath).href,
        exportName: "run",
        parseOptions: (argv, startIndex) => ({ args: argv.slice(startIndex) }),
      },
      ["/usr/bin/node", "/opt/openclaw/polytropos.mjs", "test", "claim", "--flag"],
    );

    expect(exitCode).toBe(17);
    expect(
      (globalThis as { __polytroposDispatchOptions?: unknown }).__polytroposDispatchOptions,
    ).toEqual({ args: ["--flag"] });
  });
});
