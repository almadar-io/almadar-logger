/**
 * Almadar structured logger with three-layer gating.
 *
 * Layer 1 (compile-time): `MIN_PRIORITY` derived from `NODE_ENV` + `LOG_LEVEL`.
 *                         Production defaults to WARN, dev to DEBUG.
 * Layer 2 (env):          `ALMADAR_DEBUG="ns1,ns2:*"` namespace allowlist.
 * Layer 3 (runtime):      `globalThis.__ALMADAR_DEBUG__` re-read on each call;
 *                         overrides layer 2 when set.
 *
 * Data is typed via `LogMeta` from `@almadar/core` — strict, recursive,
 * no `unknown`. The `LogData` alias also accepts a `() => LogMeta` thunk
 * that is only invoked after the priority gate passes, so call sites in
 * hot paths can defer payload construction.
 */

import type { LogMeta } from '@almadar/core';
import { envGet } from './env.js';
import { getRuntimeNamespaceFilter } from './runtime-override.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** Public data argument: either eager `LogMeta` or a lazy thunk that returns one. */
export type LogData = LogMeta | (() => LogMeta);

export interface Logger {
  debug(message: string, data?: LogData, correlationId?: string): void;
  info(message: string, data?: LogData, correlationId?: string): void;
  warn(message: string, data?: LogData, correlationId?: string): void;
  error(message: string, data?: LogData, correlationId?: string): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const NODE_ENV = envGet('NODE_ENV') ?? 'development';
const CONFIGURED_LEVEL = (
  envGet('LOG_LEVEL') ?? (NODE_ENV === 'production' ? 'warn' : 'debug')
).toUpperCase() as LogLevel;
const MIN_PRIORITY = LEVEL_PRIORITY[CONFIGURED_LEVEL] ?? 0;

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

function resolveData(data: LogData | undefined): LogMeta | undefined {
  if (data === undefined) return undefined;
  if (typeof data === 'function') return data();
  return data;
}

function attachCorrelation(data: LogMeta | undefined, cid: string | undefined): LogMeta | undefined {
  if (!cid) return data;
  return { ...(data ?? {}), cid };
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

  const dispatch = (level: LogLevel, message: string, data?: LogData, cid?: string): void => {
    if (LEVEL_PRIORITY[level] < MIN_PRIORITY) return;
    if ((level === 'DEBUG' || level === 'INFO') && !namespaceAllowed(namespace)) return;
    const resolved = resolveData(data);
    emit(level, prefix, message, attachCorrelation(resolved, cid));
  };

  return {
    debug: (msg, data, cid) => dispatch('DEBUG', msg, data, cid),
    info:  (msg, data, cid) => dispatch('INFO', msg, data, cid),
    warn:  (msg, data, cid) => dispatch('WARN', msg, data, cid),
    error: (msg, data, cid) => dispatch('ERROR', msg, data, cid),
  };
}

let _cidCounter = 0;
export function generateCorrelationId(): string {
  return `evt-${Date.now()}-${++_cidCounter}`;
}
