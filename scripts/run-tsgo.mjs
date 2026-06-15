import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readFlagValue } from "./lib/arg-utils.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  resolveLocalHeavyCheckEnv,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mjs";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mjs";
import {
  getSparseTsgoGuardError,
  shouldSkipSparseTsgoGuardError,
} from "./lib/tsgo-sparse-guard.mjs";

const DEFAULT_TSGO_HEARTBEAT_MS = 30_000;
const DEFAULT_TSGO_TERMINATION_GRACE_MS = 5_000;

function parsePositiveInteger(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.trunc(parsed);
}

async function runTsgoInvocation(invocation, env) {
  const stdout = process.stdout;
  const stderr = process.stderr;
  const heartbeatMs =
    parsePositiveInteger(env.OPENCLAW_TSGO_HEARTBEAT_MS) ?? DEFAULT_TSGO_HEARTBEAT_MS;
  const timeoutMs = parsePositiveInteger(env.OPENCLAW_TSGO_TIMEOUT_MS);
  let settled = false;
  let timedOut = false;
  let lastOutputAt = Date.now();

  const child = spawn(invocation.command, invocation.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    shell: invocation.shell,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  const pidText = child.pid ? ` pid=${child.pid}` : "";

  const markOutput = () => {
    lastOutputAt = Date.now();
  };

  child.stdout?.on("data", (chunk) => {
    markOutput();
    stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    markOutput();
    stderr.write(chunk);
  });

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (settled) {
            return;
          }
          const silentForMs = Date.now() - lastOutputAt;
          if (silentForMs < heartbeatMs) {
            return;
          }
          stderr.write(
            `[tsgo] still running${pidText}; no output for ${Math.round(silentForMs / 1000)}s\n`,
          );
          lastOutputAt = Date.now();
        }, heartbeatMs).unref()
      : null;

  const timeout =
    timeoutMs !== null
      ? setTimeout(() => {
          timedOut = true;
          stderr.write(`[tsgo] timeout after ${timeoutMs}ms${pidText}; sending SIGTERM\n`);
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!settled) {
              stderr.write(`[tsgo] forcing SIGKILL${pidText}\n`);
              child.kill("SIGKILL");
            }
          }, DEFAULT_TSGO_TERMINATION_GRACE_MS).unref();
        }, timeoutMs).unref()
      : null;

  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      resolve({ status, signal, timedOut });
    });
  });
}

const { args: finalArgs, env } = applyLocalTsgoPolicy(
  process.argv.slice(2),
  resolveLocalHeavyCheckEnv(process.env),
);

const tsgoPath = path.resolve("node_modules", ".bin", "tsgo");
const tsBuildInfoFile = readFlagValue(finalArgs, "--tsBuildInfoFile");
if (tsBuildInfoFile) {
  fs.mkdirSync(path.dirname(path.resolve(tsBuildInfoFile)), { recursive: true });
}
const sparseGuardError = getSparseTsgoGuardError(finalArgs, { cwd: process.cwd() });
const releaseLock =
  sparseGuardError ||
  env.OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD === "1" ||
  !shouldAcquireLocalHeavyCheckLockForTsgo(finalArgs, env)
    ? () => {}
    : acquireLocalHeavyCheckLockSync({
        cwd: process.cwd(),
        env,
        toolName: "tsgo",
      });

try {
  if (sparseGuardError) {
    console.error(sparseGuardError);
    if (shouldSkipSparseTsgoGuardError(env)) {
      console.error("[tsgo] skipping sparse-missing project because OPENCLAW_TSGO_SPARSE_SKIP=1");
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  } else {
    const tsgo = createManagedCommandInvocation({
      args: finalArgs,
      bin: tsgoPath,
      env,
    });
    const result = await runTsgoInvocation(tsgo, env);
    if (result.timedOut) {
      process.exitCode = 124;
    } else if (typeof result.status === "number") {
      process.exitCode = result.status;
    } else {
      process.exitCode = 1;
    }
  }
} finally {
  releaseLock();
}
