#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOTS_ENV = "OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS";

function camelCaseFlag(flag) {
  return flag.replace(/^--/, "").replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function parseOptionName(flags) {
  const match = flags.match(/--[A-Za-z0-9][A-Za-z0-9-]*/u);
  return match ? camelCaseFlag(match[0]) : null;
}

function parseCommandOptions(command, argv, startIndex) {
  const options = {};
  for (const option of command.options) {
    if (option.defaultValue !== undefined) {
      options[option.name] = option.defaultValue;
    }
  }
  const optionByFlag = new Map(command.options.map((option) => [option.flag, option]));
  for (let index = startIndex; index < argv.length; ) {
    const flag = argv[index];
    const option = optionByFlag.get(flag);
    if (!option) {
      throw new Error(`Invalid plugin CLI argument: ${flag ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Missing value for plugin CLI argument: ${flag}`);
    }
    options[option.name] = value;
    index += 2;
  }
  for (const option of command.options) {
    if (option.required && !options[option.name]) {
      throw new Error(`Missing required plugin CLI argument: ${option.flag}`);
    }
  }
  return options;
}

class CapturedCliCommand {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.options = [];
    this.actionHandler = null;
  }

  command(name) {
    const child = new CapturedCliCommand(name.split(/\s+/u)[0] ?? name);
    this.children.push(child);
    return child;
  }

  description() {
    return this;
  }

  requiredOption(flags) {
    return this.addOption(flags, true);
  }

  option(flags, _description, defaultValue) {
    return this.addOption(flags, false, defaultValue);
  }

  action(handler) {
    this.actionHandler = handler;
    return this;
  }

  addOption(flags, required, defaultValue) {
    const flag = flags.match(/--[A-Za-z0-9][A-Za-z0-9-]*/u)?.[0];
    const name = parseOptionName(flags);
    if (flag && name) {
      this.options.push({ flag, name, required, defaultValue });
    }
    return this;
  }
}

function createPluginApiCapture(pluginId, cliRegistrars) {
  const noop = () => {};
  const api = {
    id: pluginId,
    name: pluginId,
    source: "polytropos-launcher",
    registrationMode: "cli-metadata",
    config: {},
    pluginConfig: {},
    runtime: {},
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    registerCli(registrar, opts = {}) {
      const parentPath = Array.isArray(opts.parentPath) ? opts.parentPath.filter(Boolean) : [];
      const commands = [
        ...(Array.isArray(opts.commands) ? opts.commands : []),
        ...(Array.isArray(opts.descriptors)
          ? opts.descriptors.map((descriptor) => descriptor?.name).filter(Boolean)
          : []),
      ];
      if (commands.length > 0) {
        cliRegistrars.push({ pluginId, parentPath, commands, registrar });
      }
    },
  };
  return new Proxy(api, { get: (target, key) => (key in target ? target[key] : noop) });
}

function normalizePluginDefinition(moduleExports) {
  const candidate = moduleExports.default ?? moduleExports;
  if (typeof candidate === "function") {
    return { register: candidate };
  }
  if (candidate && typeof candidate.register === "function") {
    return candidate;
  }
  return null;
}

export function resolvePolytroposPluginRoots(env = process.env) {
  const raw = env[PLUGIN_ROOTS_ENV];
  if (!raw?.trim()) {
    const stateDir = env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
    return [path.join(stateDir, "extensions")];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function loadPolytroposCliClaims(options = {}) {
  const roots = options.roots ?? resolvePolytroposPluginRoots(options.env ?? process.env);
  const discoverOpenClawPlugins =
    options.discoverPlugins ??
    (await import(new URL("./dist/plugins/discovery.js", import.meta.url).href))
      .discoverOpenClawPlugins;
  const discovery = discoverOpenClawPlugins({
    extraPaths: roots,
    env: options.env ?? process.env,
  });
  const claims = [];
  for (const candidate of discovery.candidates.filter((entry) => entry.origin === "config")) {
    const cliRegistrars = [];
    try {
      const moduleExports = await import(pathToFileURL(candidate.source).href);
      const plugin = normalizePluginDefinition(moduleExports);
      plugin?.register?.(createPluginApiCapture(candidate.idHint, cliRegistrars));
    } catch {
      continue;
    }
    for (const entry of cliRegistrars) {
      for (const command of entry.commands) {
        claims.push({
          pluginId: entry.pluginId,
          commandPath: [...entry.parentPath, command],
          registrar: entry.registrar,
          parentPath: entry.parentPath,
          command,
        });
      }
    }
  }
  return claims;
}

export function resolvePolytroposCliClaim(argv, claims = []) {
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
  const parentCommand = new CapturedCliCommand(claim.parentPath.at(-1) ?? "openclaw");
  await claim.registrar({
    program: parentCommand,
    parentPath: claim.parentPath,
    config: {},
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  const command = parentCommand.children.find((child) => child.name === claim.command);
  if (!command?.actionHandler) {
    const commandPath = claim.commandPath.join(" ");
    throw new Error(`Polytropos CLI claim ${claim.pluginId} did not bind ${commandPath}`);
  }
  const options = parseCommandOptions(command, argv, 2 + claim.commandPath.length);
  const result = await command.actionHandler(options);
  return typeof result === "number" ? result : (process.exitCode ?? 0);
}

async function runCoreLauncher(argv) {
  const launcherPath = fileURLToPath(new URL("./openclaw.mjs", import.meta.url));
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath, ...argv.slice(2)], {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function runPolytroposLauncher(argv = process.argv) {
  const claim = resolvePolytroposCliClaim(argv, await loadPolytroposCliClaims());
  if (claim) {
    process.exitCode = await dispatchPolytroposCliClaim(claim, argv);
    return true;
  }

  process.exitCode = await runCoreLauncher(argv);
  return true;
}

async function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    const [modulePath, entryPath] = await Promise.all([
      fs.realpath(fileURLToPath(import.meta.url)),
      fs.realpath(entry),
    ]);
    return modulePath === entryPath;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (await isMainModule()) {
  if (await runPolytroposLauncher(process.argv)) {
    process.exit(process.exitCode ?? 0);
  }
}
