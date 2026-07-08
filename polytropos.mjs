#!/usr/bin/env node

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("Polytropos CLI (OpenClaw fork)\n");
}

const isNativeHookRelay = process.argv[2] === "hooks" && process.argv[3] === "relay";

if (isNativeHookRelay) {
  const optionNames = new Map([
    ["--provider", "provider"],
    ["--relay-id", "relayId"],
    ["--generation", "generation"],
    ["--event", "event"],
    ["--pre-tool-use-unavailable", "preToolUseUnavailable"],
    ["--timeout", "timeout"],
  ]);
  const options = {};
  for (let index = 4; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const name = optionNames.get(flag);
    const value = process.argv[index + 1];
    if (!name || value === undefined) {
      throw new Error(`Invalid native hook relay argument: ${flag ?? ""}`);
    }
    options[name] = value;
  }
  const { runNativeHookRelayCli } = await import("./dist/cli/native-hook-relay-cli.js");
  process.exitCode = await runNativeHookRelayCli(options);
} else {
  await import("./openclaw.mjs");
}
