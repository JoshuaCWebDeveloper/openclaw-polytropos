#!/usr/bin/env node

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("Polytropos CLI (OpenClaw fork)\n");
}

await import("./openclaw.mjs");
