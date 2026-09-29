/**
 * Almadar structured logger with three-layer gating.
 *
 * Layer 1 (compile-time): `MIN_PRIORITY` derived from `NODE_ENV` + `LOG_LEVEL`.
 *                         Production defaults to WARN, dev to DEBUG.
 *                         Mutable at runtime via `setLogLevel`.
 * Layer 2 (env):          `ALMADAR_DEBUG="ns1,ns2:*"` namespace allowlist.
 * Layer 3 (runtime):      `globalThis.__ALMADAR_DEBUG__` re-read on each call;
 *                         overrides layer 2 when set.
 *
 * Per-namespace level overrides (`setNamespaceLevel`) compose between
 * layers 1 and 2: a namespace can carry its own minimum priority that
 * takes precedence over the global level.
 *
 * Data is typed via `LogMeta` from `@almadar/core` — strict, recursive,
 * no `unknown`. The `LogData` alias also accepts a `() => LogMeta` thunk
 * that is only invoked after the priority gate passes, so call sites in
 * hot paths can defer payload construction.
 */

import type { CallRecord, JsonObject, JsonValue, LogContext, LogMeta, LogMetaValue, LogSeverity, StructuredLogEntry } from '@almadar/core';
import { envGet } from './env.js';
import { getRuntimeNamespaceFilter } from './runtime-override.js';
import { notifyLogConfigChange } from './observers.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Public data argument: either eager `LogMeta` or a lazy thunk that returns one. */
export type LogData = LogMeta | (() => LogMeta);

export interface Logger {
  debug(message: string, data?: LogData, correlationId?: string): void;
  info(message: string, data?: LogData, correlationId?: string): void;
  warn(message: string, data?: LogData, correlationId?: string): void;
  error(message: string, data?: LogData, correlationId?: string): void;
  /** Record one call the app made (a store, an integration, a queue, another server). */
  call(record: CallRecord): void;
}

/**
 * `console` (default): the prefixed console lines. `json`: one Cloud Logging line per entry on
 * stdout, carrying the deployment context; call records are telemetry there and pass every filter.
 */
export type LogFormat = 'console' | 'json';

export interface LogOutput {
  format: LogFormat;
  context: LogContext;
  /** The current request's context, for a process serving many apps; overrides `context` when it returns one. */
  contextOf?: () => LogContext | undefined;
  /** Also handed every structured entry (json format), e.g. to keep a local copy per app. */
  sink?: (entry: StructuredLogEntry) => void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const NODE_ENV = envGet('NODE_ENV') ?? 'development';
const INITIAL_LEVEL = (
  envGet('LOG_LEVEL') ?? (NODE_ENV === 'production' ? 'warn' : 'debug')
).toUpperCase() as LogLevel;

let currentLevel: LogLevel = LEVEL_PRIORITY[INITIAL_LEVEL] !== undefined ? INITIAL_LEVEL : 'DEBUG';
const namespaceLevels = new Map<string, LogLevel>();

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setLogLevel(level: LogLevel): void {
  if (LEVEL_PRIORITY[level] === undefined) return;
  currentLevel = level;
  notifyLogConfigChange();
}

export function setNamespaceLevel(namespace: string, level: LogLevel | null): void {
  if (level === null) {
    namespaceLevels.delete(namespace);
  } else if (LEVEL_PRIORITY[level] !== undefined) {
    namespaceLevels.set(namespace, level);
  }
  notifyLogConfigChange();
}

export function getNamespaceLevel(namespace: string): LogLevel | undefined {
  return namespaceLevels.get(namespace);
}

export function getNamespaceLevels(): ReadonlyMap<string, LogLevel> {
  return namespaceLevels;
}

const ENV_FILTER_RAW = envGet('ALMADAR_DEBUG') ?? '';
const ENV_FILTER = ENV_FILTER_RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function matchesPatterns(namespace: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  for (const pattern of patterns) {
    if (pattern === '*' || pattern === 'almadar:*') return true;
    if (pattern.endsWith(':*')) {
      if (namespace.startsWith(pattern.slice(0, -1))) return true;
      continue;
    }
    if (namespace === pattern) return true;
  }
  return false;
}

function namespaceAllowed(namespace: string): boolean {
  const runtime = getRuntimeNamespaceFilter();
  if (runtime !== undefined) {
    if (runtime === '') return false;
    const patterns = runtime.split(',').map(s => s.trim()).filter(Boolean);
    return matchesPatterns(namespace, patterns);
  }
  if (ENV_FILTER.length === 0) return true;
  return matchesPatterns(namespace, ENV_FILTER);
}

function effectiveMinPriority(namespace: string): number {
  // Per-namespace override beats global. Exact match first, then
  // prefix-wildcard match (`almadar:ui:*` covers `almadar:ui:flow-canvas`).
  const exact = namespaceLevels.get(namespace);
  if (exact !== undefined) return LEVEL_PRIORITY[exact];
  for (const [pattern, level] of namespaceLevels) {
    if (pattern.endsWith(':*') && namespace.startsWith(pattern.slice(0, -1))) {
      return LEVEL_PRIORITY[level];
    }
  }
  return LEVEL_PRIORITY[currentLevel];
}

export function isLogLevelEnabled(level: LogLevel, namespace: string): boolean {
  if (LEVEL_PRIORITY[level] < effectiveMinPriority(namespace)) return false;
  if (level === 'DEBUG' || level === 'INFO') {
    return namespaceAllowed(namespace);
  }
  return true;
}

function resolveData(data: LogData | undefined): LogMeta | undefined {
  if (data === undefined) return undefined;
  if (typeof data === 'function') return data();
  return data;
}

function attachCorrelation(data: LogMeta | undefined, cid: string | undefined): LogMeta | undefined {
  if (!cid) return data;
  return { ...(data ?? {}), cid };
}

const INITIAL_FORMAT: LogFormat = envGet('ALMADAR_LOG_FORMAT') === 'json' ? 'json' : 'console';
let output: LogOutput = { format: INITIAL_FORMAT, context: {} };

export function configureLogOutput(next: { format: LogFormat; context?: LogContext; contextOf?: () => LogContext | undefined; sink?: (entry: StructuredLogEntry) => void }): void {
  output = {
    format: next.format,
    context: next.context ?? {},
    ...(next.contextOf ? { contextOf: next.contextOf } : {}),
    ...(next.sink ? { sink: next.sink } : {}),
  };
}

export function getLogOutput(): LogOutput {
  return output;
}

const SEVERITY: Record<LogLevel, LogSeverity> = { DEBUG: 'DEBUG', INFO: 'INFO', WARN: 'WARNING', ERROR: 'ERROR' };

function isMetaList(value: LogMetaValue): value is readonly LogMetaValue[] {
  return Array.isArray(value);
}

function toJson(value: LogMetaValue): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}) };
  if (isMetaList(value)) return value.map((item) => toJson(item) ?? null);
  return metaToJson(value);
}

function metaToJson(meta: LogMeta): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(meta)) {
    const json = toJson(value);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function emitJson(level: LogLevel, namespace: string, message: string, payload: LogMeta | undefined, call?: CallRecord): void {
  const entry: StructuredLogEntry = {
    severity: SEVERITY[level],
    time: new Date().toISOString(),
    namespace,
    message,
    ...(output.contextOf?.() ?? output.context),
    ...(payload ? { data: metaToJson(payload) } : {}),
    ...(call ? { call } : {}),
  };
  console.log(JSON.stringify(entry));
  output.sink?.(entry);
}

function emit(level: LogLevel, prefix: string, message: string, payload: LogMeta | undefined): void {
  const data: LogMeta | string = payload ?? '';
  switch (level) {
    case 'DEBUG': console.debug(prefix, message, data); break;
    case 'INFO':  console.info(prefix, message, data); break;
    case 'WARN':  console.warn(prefix, message, data); break;
    case 'ERROR': console.error(prefix, message, data); break;
  }
}

export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;

  const allowed = (level: LogLevel): boolean =>
    LEVEL_PRIORITY[level] >= effectiveMinPriority(namespace) && ((level !== 'DEBUG' && level !== 'INFO') || namespaceAllowed(namespace));

  const dispatch = (level: LogLevel, message: string, data?: LogData, cid?: string): void => {
    if (!allowed(level)) return;
    const payload = attachCorrelation(resolveData(data), cid);
    if (output.format === 'json') emitJson(level, namespace, message, payload);
    else emit(level, prefix, message, payload);
  };

  const call = (record: CallRecord): void => {
    const message = `${record.kind} ${record.service} ${record.op}`;
    if (output.format === 'json') {
      emitJson(record.ok ? 'INFO' : 'WARN', namespace, message, undefined, record);
      return;
    }
    if (!allowed('INFO')) return;
    const { kind, service, op, durationMs, ok, error } = record;
    emit('INFO', prefix, message, { kind, service, op, durationMs, ok, ...(error !== undefined ? { error } : {}) });
  };

  return {
    debug: (msg, data, cid) => dispatch('DEBUG', msg, data, cid),
    info:  (msg, data, cid) => dispatch('INFO', msg, data, cid),
    warn:  (msg, data, cid) => dispatch('WARN', msg, data, cid),
    error: (msg, data, cid) => dispatch('ERROR', msg, data, cid),
    call,
  };
}

let _cidCounter = 0;
export function generateCorrelationId(): string {
  return `evt-${Date.now()}-${++_cidCounter}`;
}

/** Run `fn` as one call and record it on `logger`: its duration, and its error when it throws (then rethrows). */
export async function timeCall<T>(logger: Logger, call: Pick<CallRecord, 'kind' | 'service' | 'op'>, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    logger.call({ ...call, durationMs: performance.now() - start, ok: true });
    return result;
  } catch (err) {
    logger.call({ ...call, durationMs: performance.now() - start, ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
