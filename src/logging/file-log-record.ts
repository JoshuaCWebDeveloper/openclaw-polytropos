import { formatTimestamp } from "./timestamps.js";

export type FileLogTraceContext = {
  readonly traceId: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly traceFlags?: string;
};

export type FileLogRecord = Record<string, unknown>;

const MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS = 8 * 1024;
const MAX_FILE_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_FILE_LOG_CONTEXT_VALUE_CHARS = 512;

const TRACE_ID_RE = /^[0-9a-f]{32}$/u;
const SPAN_ID_RE = /^[0-9a-f]{16}$/u;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/u;

function isNonZeroHex(value: string): boolean {
  return !/^0+$/u.test(value);
}

function isValidTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}

function isValidSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}

function isValidTraceFlags(value: unknown): value is string {
  return typeof value === "string" && TRACE_FLAGS_RE.test(value);
}

export function isPlainLogRecordObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function getSortedNumericLogArgs(logObj: FileLogRecord): unknown[] {
  return Object.entries(logObj)
    .filter(([key]) => /^\d+$/u.test(key))
    .toSorted((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);
}

function clampFileLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

function normalizeFileLogContextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? clampFileLogText(normalized, MAX_FILE_LOG_CONTEXT_VALUE_CHARS) : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function readFirstContextString(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      const value = normalizeFileLogContextValue(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function stringifyFileLogMessagePart(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (isPlainLogRecordObject(value) && typeof value.message === "string") {
    return value.message;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function buildFileLogMessage(numericArgs: readonly unknown[]): string | undefined {
  const parts = numericArgs
    .map(stringifyFileLogMessagePart)
    .filter((part): part is string => Boolean(part && part.trim()));
  if (parts.length === 0) {
    return undefined;
  }
  return clampFileLogText(parts.join(" "), MAX_FILE_LOG_MESSAGE_CHARS);
}

function normalizeTraceContext(value: unknown): FileLogTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<FileLogTraceContext>;
  if (!isValidTraceId(candidate.traceId)) {
    return undefined;
  }
  if (candidate.spanId !== undefined && !isValidSpanId(candidate.spanId)) {
    return undefined;
  }
  if (candidate.parentSpanId !== undefined && !isValidSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  if (candidate.traceFlags !== undefined && !isValidTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

function extractTraceContext(value: unknown): FileLogTraceContext | undefined {
  const direct = normalizeTraceContext(value);
  if (direct) {
    return direct;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return normalizeTraceContext((value as { trace?: unknown }).trace);
}

export function extractLogBindingPrefix(numericArgs: unknown[]): {
  bindings?: Record<string, unknown>;
  args: unknown[];
} {
  if (
    typeof numericArgs[0] === "string" &&
    numericArgs[0].length <= MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS &&
    numericArgs[0].trim().startsWith("{")
  ) {
    try {
      const parsed = JSON.parse(numericArgs[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          bindings: parsed as Record<string, unknown>,
          args: numericArgs.slice(1),
        };
      }
    } catch {
      // ignore malformed json bindings
    }
  }
  return { args: numericArgs };
}

export function findLogTraceContext(
  bindings: Record<string, unknown> | undefined,
  numericArgs: readonly unknown[],
): FileLogTraceContext | undefined {
  const fromBindings = extractTraceContext(bindings);
  if (fromBindings) {
    return fromBindings;
  }
  for (const arg of numericArgs) {
    const fromArg = extractTraceContext(arg);
    if (fromArg) {
      return fromArg;
    }
  }
  return undefined;
}

function buildTraceFileLogFields(
  logObj: FileLogRecord,
  activeTraceContext?: FileLogTraceContext,
): Record<string, string> | undefined {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const trace = findLogTraceContext(bindings, args) ?? activeTraceContext;
  if (!trace) {
    return undefined;
  }
  return {
    traceId: trace.traceId,
    ...(trace.spanId ? { spanId: trace.spanId } : {}),
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    ...(trace.traceFlags ? { traceFlags: trace.traceFlags } : {}),
  };
}

function buildStructuredFileLogFields(
  logObj: FileLogRecord,
  hostname: string,
): Record<string, string> {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const structuredArg = isPlainLogRecordObject(args[0]) ? args[0] : undefined;
  const sources = [structuredArg, bindings, logObj];
  const messageArgs =
    structuredArg && typeof structuredArg.message !== "string" ? args.slice(1) : args;
  const message = buildFileLogMessage(messageArgs);
  const agentId = readFirstContextString(sources, ["agent_id", "agentId"]);
  const sessionId = readFirstContextString(sources, ["session_id", "sessionId", "sessionKey"]);
  const channel = readFirstContextString(sources, ["channel", "messageProvider"]);
  return {
    hostname,
    ...(message ? { message } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(channel ? { channel } : {}),
  };
}

function withResolvedLogMetaHostname(meta: unknown, hostname: string): unknown {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return meta;
  }
  return { ...(meta as Record<string, unknown>), hostname };
}

export function buildOpenClawFileLogRecord(params: {
  logObj: FileLogRecord;
  date: Date;
  hostname: string;
  activeTraceContext?: FileLogTraceContext;
}): FileLogRecord {
  const traceFields = buildTraceFileLogFields(params.logObj, params.activeTraceContext);
  const structuredFields = buildStructuredFileLogFields(params.logObj, params.hostname);
  return {
    ...params.logObj,
    _meta: withResolvedLogMetaHostname(params.logObj["_meta"], structuredFields.hostname),
    time: formatTimestamp(params.date, { style: "long" }),
    ...structuredFields,
    ...traceFields,
  };
}

export function buildOpenClawInfoFileLogRecord(params: {
  message: string;
  fields?: Record<string, unknown>;
  date: Date;
  hostname: string;
}): FileLogRecord {
  return buildOpenClawFileLogRecord({
    logObj: {
      "0": params.fields ?? {},
      "1": params.message,
      _meta: {
        runtime: "node",
        runtimeVersion: process.versions.node,
        name: "openclaw",
        date: params.date,
        logLevelId: 3,
        logLevelName: "INFO",
      },
    },
    date: params.date,
    hostname: params.hostname,
  });
}
