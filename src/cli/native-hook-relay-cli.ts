import { Readable, Writable } from "node:stream";
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
  renderNativeHookRelayUnavailableResponse,
  type NativeHookRelayProcessResponse,
} from "../agents/harness/native-hook-relay.js";
import { callGateway } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;
const log = createSubsystemLogger("cli/native-hook-relay");

export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  generation?: string;
  event?: string;
  preToolUseUnavailable?: string;
  timeout?: string;
};

type NativeHookRelayCliDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  invokeBridge?: typeof invokeNativeHookRelayBridge;
  callGateway?: typeof callGateway;
  logger?: Pick<SubsystemLogger, "debug">;
};

export async function runNativeHookRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const invokeBridge = deps.invokeBridge ?? invokeNativeHookRelayBridge;
  const callGatewayFn = deps.callGateway ?? callGateway;
  const logger = deps.logger ?? log;
  logger.debug("native hook relay CLI parsing options", {
    provider: opts.provider,
    event: opts.event,
    hasRelayId: Boolean(opts.relayId?.trim()),
    hasGeneration: Boolean(opts.generation?.trim()),
    timeout: opts.timeout,
  });
  let provider: string;
  let relayId: string;
  let event: string;
  try {
    provider = readRequiredOption(opts.provider, "provider");
    relayId = readRequiredOption(opts.relayId, "relay-id");
    event = readRequiredOption(opts.event, "event");
  } catch (error) {
    logger.debug("native hook relay CLI option validation failed", {
      error: formatErrorForLog(error),
    });
    writeText(stderr, formatRelayCliError("invalid native hook relay options", error));
    return 1;
  }
  const generation = opts.generation?.trim() || undefined;
  let timeoutMs: number;
  try {
    timeoutMs = parseTimeoutMsWithFallback(opts.timeout, 5_000);
  } catch (error) {
    logger.debug("native hook relay CLI timeout validation failed", {
      provider,
      relayId,
      event,
      error: formatErrorForLog(error),
    });
    writeText(stderr, formatRelayCliError("invalid native hook timeout", error));
    return 1;
  }

  let rawPayload: unknown;
  try {
    const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES);
    rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
    logger.debug("native hook relay CLI input parsed", {
      provider,
      relayId,
      event,
      bytes: Buffer.byteLength(rawInput),
    });
  } catch (error) {
    logger.debug("native hook relay CLI input validation failed", {
      provider,
      relayId,
      event,
      error: formatErrorForLog(error),
    });
    writeText(stderr, formatRelayCliError("failed to read native hook input", error));
    return 1;
  }

  try {
    const response = await invokeBridge({
      provider,
      relayId,
      generation,
      event,
      rawPayload,
      registrationTimeoutMs: 100,
      timeoutMs,
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    logger.debug("native hook relay CLI bridge completed", {
      provider,
      relayId,
      event,
      exitCode: response.exitCode,
    });
    return response.exitCode;
  } catch (error) {
    if (isNativeHookRelayBridgeStaleRegistrationError(error)) {
      logger.debug("native hook relay CLI bridge stale registration", {
        provider,
        relayId,
        event,
        error: formatErrorForLog(error),
      });
      writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
      const response = renderNativeHookRelayUnavailableResponse({
        provider,
        event,
        preToolUseUnavailable: opts.preToolUseUnavailable,
        message: "Native hook relay unavailable",
      });
      writeText(stdout, response.stdout);
      writeText(stderr, response.stderr);
      return response.exitCode;
    }
    logger.debug("native hook relay CLI bridge unavailable; trying gateway fallback", {
      provider,
      relayId,
      event,
      error: formatErrorForLog(error),
    });
    // Fall through to the gateway path for embedded/local gateway cases and
    // older registrations that predate the direct relay bridge.
  }

  try {
    const response = await callGatewayFn<NativeHookRelayProcessResponse>({
      method: "nativeHook.invoke",
      params: { provider, relayId, generation, event, rawPayload },
      timeoutMs,
      scopes: [ADMIN_SCOPE],
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    logger.debug("native hook relay CLI gateway fallback completed", {
      provider,
      relayId,
      event,
      exitCode: response.exitCode,
    });
    return response.exitCode;
  } catch (error) {
    logger.debug("native hook relay CLI gateway fallback failed", {
      provider,
      relayId,
      event,
      error: formatErrorForLog(error),
    });
    writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
    const response = renderNativeHookRelayUnavailableResponse({
      provider,
      event,
      preToolUseUnavailable: opts.preToolUseUnavailable,
      message: "Native hook relay unavailable",
    });
    writeText(stdout, response.stdout);
    writeText(stderr, response.stderr);
    return response.exitCode;
  }
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(stream: NodeJS.ReadableStream, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new Error(`native hook input exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function writeText(stream: NodeJS.WritableStream, value: string | undefined): void {
  if (value) {
    stream.write(value);
  }
}

function formatRelayCliError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}\n`;
}

function formatErrorForLog(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createReadableTextStream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

export function createWritableTextBuffer(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      callback();
    },
  });
  return Object.assign(stream, {
    text: () => Buffer.concat(chunks).toString("utf8"),
  });
}
