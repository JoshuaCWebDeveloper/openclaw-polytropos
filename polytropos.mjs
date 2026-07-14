#!/usr/bin/env node

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOTS_ENV = "OPENCLAW_POLYTROPOS_CLI_PLUGIN_ROOTS";
const DEBUG_ENV = "OPENCLAW_POLYTROPOS_CLI_DEBUG";
const LOG_PATH_ENV = "OPENCLAW_POLYTROPOS_CLI_LOG_PATH";
const CLI_METADATA_ENTRY_BASENAMES = [
  "cli-metadata.ts",
  "cli-metadata.js",
  "cli-metadata.mjs",
  "cli-metadata.cjs",
];
const SCANNED_DIRECTORY_IGNORE_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".turbo",
  ".yarn",
  ".yarn-cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

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

function isHelpArg(value) {
  return value === "--help" || value === "-h";
}

function formatCommandHelp(command, commandPath) {
  const heading = (value) => colorizeAnsi(value, "1;38;5;39");
  const optionText = (value) => colorizeAnsi(value, "38;5;214");
  const lines = [
    `${heading("Usage:")} openclaw ${commandPath.join(" ")} [options]`,
    "",
    command.descriptionText ? `${command.descriptionText}\n` : "",
    `${heading("Options:")}`,
  ].filter((line) => line !== "");
  for (const option of command.options) {
    const required = option.required ? " (required)" : "";
    const description = option.descriptionText ? `  ${option.descriptionText}` : "";
    lines.push(`  ${optionText(option.flags)}${description}${required}`);
  }
  lines.push(`  ${optionText("-h, --help")}  display help for command`, "");
  return lines.join("\n");
}

class CapturedCliCommand {
  constructor(name) {
    this.name = name;
    this.children = [];
    this.options = [];
    this.actionHandler = null;
    this.descriptionText = "";
  }

  command(name) {
    const child = new CapturedCliCommand(name.split(/\s+/u)[0] ?? name);
    this.children.push(child);
    return child;
  }

  description(text) {
    if (typeof text === "string") {
      this.descriptionText = text;
    }
    return this;
  }

  requiredOption(flags, descriptionText) {
    return this.addOption(flags, true, undefined, descriptionText);
  }

  option(flags, descriptionText, defaultValue) {
    return this.addOption(flags, false, defaultValue, descriptionText);
  }

  action(handler) {
    this.actionHandler = handler;
    return this;
  }

  addOption(flags, required, defaultValue, descriptionText = "") {
    const flag = flags.match(/--[A-Za-z0-9][A-Za-z0-9-]*/u)?.[0];
    const name = parseOptionName(flags);
    if (flag && name) {
      this.options.push({ flag, flags, name, required, defaultValue, descriptionText });
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
        ...new Set([
          ...(Array.isArray(opts.commands) ? opts.commands : []),
          ...(Array.isArray(opts.descriptors)
            ? opts.descriptors.map((descriptor) => descriptor?.name).filter(Boolean)
            : []),
        ]),
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

async function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveHomeDir(env = process.env) {
  const override = env.OPENCLAW_HOME?.trim();
  if (override) {
    return path.resolve(override.replace(/^~(?=$|[/\\])/u, os.homedir()));
  }
  return os.homedir();
}

function resolveUserPath(input, env = process.env) {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return resolveHomeDir(env);
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(resolveHomeDir(env), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function resolveConfigDir(env = process.env) {
  const stateDir = env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return resolveUserPath(stateDir, env);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveUserPath(configPath, env));
  }
  return path.join(resolveHomeDir(env), ".openclaw");
}

function isTruthyEnvValue(value) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldUseAnsiColor(env = process.env) {
  if (env.NO_COLOR && !env.FORCE_COLOR) {
    return false;
  }
  return isTruthyEnvValue(env.FORCE_COLOR);
}

function colorizeAnsi(value, code, env = process.env) {
  return shouldUseAnsiColor(env) ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function quoteLogValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return `"${String(value).replace(/[\\\n\r"]/gu, (match) => {
    if (match === "\\") {
      return "\\\\";
    }
    if (match === "\n") {
      return "\\n";
    }
    if (match === "\r") {
      return "\\r";
    }
    return '\\"';
  })}"`;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveConfigPath(env = process.env) {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return path.join(resolveConfigDir(env), "openclaw.json");
}

function readConfiguredLogFile(env = process.env) {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(resolveConfigPath(env), "utf8"));
    const configured = parsed?.logging?.file;
    return typeof configured === "string" && configured.trim()
      ? resolveUserPath(configured.trim(), env)
      : null;
  } catch {
    return null;
  }
}

function resolveDefaultOpenClawLogFile() {
  return path.join(os.tmpdir(), "openclaw", `openclaw-${formatLocalDate(new Date())}.log`);
}

function resolvePolytroposCliLogPath(env = process.env) {
  const override = env[LOG_PATH_ENV]?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }
  return readConfiguredLogFile(env) ?? resolveDefaultOpenClawLogFile();
}

function writePolytroposProbeLog(message, fields = {}, env = process.env) {
  const logPath = resolvePolytroposCliLogPath(env);
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${quoteLogValue(value)}`)
    .join(" ");
  const line = `${new Date().toISOString()} info polytropos cli: ${message}${suffix ? ` ${suffix}` : ""}\n`;
  try {
    fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
    fsSync.appendFileSync(logPath, line, "utf8");
  } catch {
    // Best-effort observability only; hook relay stdout/stderr remain provider protocol.
  }
}

function writePolytroposDebug(message, fields = {}, env = process.env) {
  if (!isTruthyEnvValue(env[DEBUG_ENV])) {
    return;
  }
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  process.stderr.write(`[polytropos cli] ${message}${suffix ? ` ${suffix}` : ""}\n`);
}

function hasUsablePluginTree(root) {
  try {
    return fsSync.readdirSync(root, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        return false;
      }
      const pluginDir = path.join(root, entry.name);
      return (
        fsSync.existsSync(path.join(pluginDir, "package.json")) ||
        fsSync.existsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

function isSourceCheckoutRoot(root) {
  return (
    fsSync.existsSync(path.join(root, "pnpm-workspace.yaml")) &&
    fsSync.existsSync(path.join(root, "src")) &&
    fsSync.existsSync(path.join(root, "extensions"))
  );
}

function resolveBundledPluginsDirFallback(env = process.env) {
  if (isTruthyEnvValue(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS)) {
    return path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");
  }
  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }

  const packageRoot = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(packageRoot, "dist", "extensions"),
    path.join(packageRoot, "dist-runtime", "extensions"),
    ...(isSourceCheckoutRoot(packageRoot) ? [path.join(packageRoot, "extensions")] : []),
  ];
  return candidates.find((candidate) =>
    isSourceCheckoutRoot(packageRoot)
      ? hasUsablePluginTree(candidate)
      : fsSync.existsSync(candidate),
  );
}

async function resolveOpenClawPluginSourceRoots(env = process.env) {
  try {
    const rootsModule = await import(new URL("./dist/plugins/roots.js", import.meta.url).href);
    if (typeof rootsModule.resolvePluginSourceRoots === "function") {
      return rootsModule.resolvePluginSourceRoots({ env });
    }
  } catch {
    // Source checkouts under test do not have dist entries yet. Keep this
    // fallback aligned with src/plugins/roots.ts without importing the loader.
  }
  return {
    stock: resolveBundledPluginsDirFallback(env),
    global: path.join(resolveConfigDir(env), "extensions"),
  };
}

function uniquePaths(entries) {
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.trim()) {
      continue;
    }
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function resolveCliMetadataEntrySource(root) {
  for (const dirname of ["", "dist"]) {
    for (const basename of CLI_METADATA_ENTRY_BASENAMES) {
      const candidate = path.join(root, dirname, basename);
      try {
        if (fsSync.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function resolvePackageExtensionEntries(root, packageJson) {
  const openclaw = packageJson.openclaw;
  const extensions =
    openclaw && typeof openclaw === "object" && Array.isArray(openclaw.extensions)
      ? openclaw.extensions
      : [];
  return extensions
    .filter((entry) => typeof entry === "string" && entry.trim())
    .map((entry) => path.resolve(root, entry.trim()));
}

function resolveManifestCliAliases(manifest) {
  const aliases = Array.isArray(manifest?.commandAliases) ? manifest.commandAliases : [];
  return aliases
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (!entry || typeof entry !== "object") {
        return "";
      }
      return typeof entry.cliCommand === "string" && entry.cliCommand.trim()
        ? entry.cliCommand.trim()
        : "";
    })
    .filter(Boolean);
}

async function readPluginCandidate(root) {
  const manifest = await readJsonObject(path.join(root, "openclaw.plugin.json"));
  const packageJson = await readJsonObject(path.join(root, "package.json"));
  const id =
    typeof manifest?.id === "string" && manifest.id.trim()
      ? manifest.id.trim()
      : typeof packageJson?.name === "string" && packageJson.name.trim()
        ? packageJson.name.trim().replace(/^@[^/]+\//u, "")
        : "";
  const manifestEntry =
    typeof manifest?.entry === "string" && manifest.entry.trim()
      ? path.resolve(root, manifest.entry.trim())
      : undefined;
  const source = manifestEntry ?? resolvePackageExtensionEntries(root, packageJson ?? {})[0];
  const cliMetadataSource = resolveCliMetadataEntrySource(root);
  const cliAliases = resolveManifestCliAliases(manifest);
  if (id && source) {
    return { id, source, root, cliMetadataSource, cliAliases };
  }

  const packedManifest = await readJsonObject(path.join(root, "dist", "openclaw.plugin.json"));
  const packedId =
    typeof packedManifest?.id === "string" && packedManifest.id.trim()
      ? packedManifest.id.trim()
      : id;
  const packedEntry =
    typeof packedManifest?.entry === "string" && packedManifest.entry.trim()
      ? path.resolve(root, "dist", packedManifest.entry.trim())
      : undefined;
  const packedCliAliases = resolveManifestCliAliases(packedManifest);
  return packedId && packedEntry
    ? {
        id: packedId,
        source: packedEntry,
        root,
        cliMetadataSource,
        cliAliases: packedCliAliases,
      }
    : null;
}

async function isDirectoryLike(entryPath) {
  try {
    return (await fs.stat(entryPath)).isDirectory();
  } catch {
    return false;
  }
}

async function findPluginCandidates(root) {
  const candidates = [];
  const queue = [{ dir: root, depth: 0 }];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    let realDir;
    try {
      realDir = await fs.realpath(current.dir);
    } catch {
      continue;
    }
    if (visited.has(realDir)) {
      continue;
    }
    visited.add(realDir);

    const candidate = await readPluginCandidate(current.dir);
    if (candidate) {
      candidates.push(candidate);
      continue;
    }
    if (current.depth >= 2) {
      continue;
    }

    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (shouldIgnoreScannedDirectory(entry.name)) {
        continue;
      }
      const entryPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink() || (await isDirectoryLike(entryPath))) {
        queue.push({ dir: entryPath, depth: current.depth + 1 });
      }
    }
  }
  return candidates;
}

function shouldIgnoreScannedDirectory(dirName) {
  const normalized = dirName.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (SCANNED_DIRECTORY_IGNORE_NAMES.has(normalized)) {
    return true;
  }
  if (normalized.endsWith(".bak")) {
    return true;
  }
  if (normalized.includes(".backup-")) {
    return true;
  }
  if (normalized.includes(".disabled")) {
    return true;
  }
  return false;
}

export function resolvePolytroposPluginRoots(env = process.env) {
  const raw = env[PLUGIN_ROOTS_ENV];
  if (!raw?.trim()) {
    return [path.join(resolveConfigDir(env), "extensions")];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => resolveUserPath(entry, env))
    .filter(Boolean);
}

async function resolvePolytroposPluginEnumerationRoots(env = process.env) {
  const roots = await resolveOpenClawPluginSourceRoots(env);
  return uniquePaths([
    ...resolvePolytroposPluginRoots(env),
    // Polytropos launcher claims are installed-plugin metadata, so enumerate
    // config-style roots plus OpenClaw's global extensions root. Bundled/source
    // plugin trees are large in source checkouts and are handled by core CLI.
    roots.global,
  ]);
}

export async function loadPolytroposCliClaims(options = {}) {
  const roots =
    options.roots ?? (await resolvePolytroposPluginEnumerationRoots(options.env ?? process.env));
  const candidates = (await Promise.all(roots.map((root) => findPluginCandidates(root)))).flat();
  const claims = [];
  const seenClaims = new Set();
  const pushClaim = (claim) => {
    const key = `${claim.pluginId}\0${claim.commandPath.join("\0")}`;
    if (seenClaims.has(key)) {
      return;
    }
    seenClaims.add(key);
    claims.push(claim);
  };
  for (const candidate of candidates) {
    for (const command of candidate.cliAliases ?? []) {
      pushClaim({
        pluginId: candidate.id,
        commandPath: [command],
        registrar: null,
        parentPath: [],
        command,
        source: candidate.source,
      });
    }
    if (!candidate.cliMetadataSource) {
      continue;
    }
    const cliRegistrars = [];
    try {
      const moduleExports = await import(pathToFileURL(candidate.cliMetadataSource).href);
      const plugin = normalizePluginDefinition(moduleExports);
      plugin?.register?.(createPluginApiCapture(candidate.id, cliRegistrars));
    } catch {
      continue;
    }
    for (const entry of cliRegistrars) {
      for (const command of entry.commands) {
        pushClaim({
          pluginId: entry.pluginId,
          commandPath: [...entry.parentPath, command],
          registrar: null,
          parentPath: entry.parentPath,
          command,
          source: candidate.source,
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
  let registrar = claim.registrar;
  if (!registrar && claim.source) {
    const cliRegistrars = [];
    const moduleExports = await import(pathToFileURL(claim.source).href);
    const plugin = normalizePluginDefinition(moduleExports);
    plugin?.register?.(createPluginApiCapture(claim.pluginId, cliRegistrars));
    registrar =
      cliRegistrars.find(
        (entry) =>
          entry.parentPath.length === claim.parentPath.length &&
          entry.parentPath.every((segment, index) => segment === claim.parentPath[index]) &&
          entry.commands.includes(claim.command),
      )?.registrar ?? null;
  }
  if (!registrar) {
    const commandPath = claim.commandPath.join(" ");
    throw new Error(`Polytropos CLI claim ${claim.pluginId} did not bind ${commandPath}`);
  }
  const parentCommand = new CapturedCliCommand(claim.parentPath.at(-1) ?? "openclaw");
  await registrar({
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
  if (argv.slice(2 + claim.commandPath.length).some(isHelpArg)) {
    process.stdout.write(formatCommandHelp(command, claim.commandPath));
    return 0;
  }
  const options = parseCommandOptions(command, argv, 2 + claim.commandPath.length);
  const result = await command.actionHandler(options);
  return typeof result === "number" ? result : (process.exitCode ?? 0);
}

export async function runCoreLauncher(argv, deps = {}) {
  const launcherPath = fileURLToPath(new URL("./openclaw.mjs", import.meta.url));
  return await new Promise((resolve, reject) => {
    const stdout = deps.stdout ?? process.stdout;
    const stderr = deps.stderr ?? process.stderr;
    const spawnImpl = deps.spawn ?? spawn;
    const stdoutMode = stdout.isTTY ? "inherit" : "pipe";
    const stderrMode = stderr.isTTY ? "inherit" : "pipe";
    const child = spawnImpl(process.execPath, [launcherPath, ...argv.slice(2)], {
      stdio: ["inherit", stdoutMode, stderrMode],
      env: deps.env ?? process.env,
    });
    child.stdout?.on("data", (chunk) => {
      stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function runPolytroposLauncher(argv = process.argv) {
  if (argv.includes("--no-color")) {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "0";
  }
  const claim = resolvePolytroposCliClaim(argv, await loadPolytroposCliClaims());
  if (claim) {
    writePolytroposDebug("dispatching plugin CLI claim", {
      plugin: claim.pluginId,
      command: claim.commandPath.join(" "),
    });
    try {
      process.exitCode = await dispatchPolytroposCliClaim(claim, argv);
    } catch (error) {
      process.exitCode = 1;
      process.stderr.write(`${formatPolytroposLauncherError(error)}\n`);
    }
    writePolytroposDebug("plugin CLI claim completed", {
      plugin: claim.pluginId,
      command: claim.commandPath.join(" "),
      exitCode: process.exitCode,
    });
    if (claim.commandPath.join(" ") === "hooks relay") {
      writePolytroposProbeLog("claimed hooks relay probe", {
        plugin: claim.pluginId,
        command: `openclaw ${argv.slice(2).join(" ")}`.trim(),
        exitCode: process.exitCode,
      });
    }
    return true;
  }

  process.exitCode = await runCoreLauncher(argv);
  if (argv.slice(2, 4).join(" ") === "hooks relay") {
    writePolytroposProbeLog("fallback hooks relay probe", {
      command: `openclaw ${argv.slice(2).join(" ")}`.trim(),
      exitCode: process.exitCode,
    });
  }
  return true;
}

function formatPolytroposLauncherError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `polytropos launcher: ${message}`;
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
  await runPolytroposLauncher(process.argv);
}
