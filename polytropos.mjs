#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const DEFAULT_POLYTROPOS_CLI_CLAIMS = [
  {
    pluginId: "polytropos-codex",
    commandPath: ["hooks", "relay"],
    module: "./dist/cli/native-hook-relay-cli.js",
    exportName: "runNativeHookRelayCli",
    parseOptions: parseNativeHookRelayOptions,
  },
];

export function parseNativeHookRelayOptions(argv, startIndex) {
  const optionNames = new Map([
    ["--provider", "provider"],
    ["--relay-id", "relayId"],
    ["--generation", "generation"],
    ["--event", "event"],
    ["--pre-tool-use-unavailable", "preToolUseUnavailable"],
    ["--timeout", "timeout"],
  ]);
  const options = {};
  for (let index = startIndex; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = optionNames.get(flag);
    const value = argv[index + 1];
    if (!name || value === undefined) {
      throw new Error(`Invalid native hook relay argument: ${flag ?? ""}`);
    }
    options[name] = value;
  }
  return options;
}

export function resolvePolytroposCliClaim(argv, claims = DEFAULT_POLYTROPOS_CLI_CLAIMS) {
  const args = argv.slice(2);
  let selected = null;
  for (const claim of claims) {
    const commandPath = claim.commandPath;
    if (
      commandPath.length === 0 ||
      commandPath.length > args.length ||
      !commandPath.every((segment, index) => args[index] === segment)
    ) {
      continue;
    }
    if (!selected || commandPath.length > selected.commandPath.length) {
      selected = claim;
    }
  }
  return selected;
}

export async function dispatchPolytroposCliClaim(claim, argv) {
  const moduleExports = await import(claim.module);
  const run = moduleExports[claim.exportName];
  if (typeof run !== "function") {
    throw new Error(
      `Polytropos CLI claim ${claim.pluginId} missing handler export ${claim.exportName}`,
    );
  }
  return await run(claim.parseOptions(argv, 2 + claim.commandPath.length));
}

export async function runPolytroposLauncher(argv = process.argv) {
  if (argv.length === 3 && argv[2] === "--version") {
    process.stdout.write("Polytropos CLI (OpenClaw fork)\n");
  }

  const claim = resolvePolytroposCliClaim(argv);
  if (claim) {
    process.exitCode = await dispatchPolytroposCliClaim(claim, argv);
    return;
  }

  await import("./openclaw.mjs");
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  await runPolytroposLauncher(process.argv);
}
