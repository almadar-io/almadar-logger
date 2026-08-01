/**
 * Request-scoped performance timing — `AsyncLocalStorage` + `perf_hooks`,
 * surfaced as a `Server-Timing` response header.
 *
 * Node-only (uses `node:` built-ins). Exposed solely via the
 * `@almadar/logger/timing` subpath so the browser-safe main entry never pulls
 * `async_hooks`/`perf_hooks`. Framework-agnostic: the middleware is typed against
 * Node's `http` types, so any framework whose `res` extends `ServerResponse`
 * (Express, connect, raw http) works without a framework dependency.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger, LogData } from './logger.js';
import { envGet } from './env.js';

/** name → accumulated milliseconds for the current request. */
export type TimingStore = Map<string, number>;

// Use globalThis so the AsyncLocalStorage is shared across duplicated module
// instances (pnpm hoists @almadar/logger separately for the app and its deps).
// Without this, profile() calls from a dependency don't reach the timing store
// created by timingMiddleware in the app's own logger copy.
const globalKey = Symbol.for('@almadar/logger/timingStore');
function getTimingStore(): AsyncLocalStorage<TimingStore> {
  if (!(globalThis as Record<symbol, unknown>)[globalKey]) {
    (globalThis as Record<symbol, unknown>)[globalKey] = new AsyncLocalStorage<TimingStore>();
  }
  return (globalThis as Record<symbol, AsyncLocalStorage<TimingStore>>)[globalKey];
}

export const timingStore = getTimingStore();

/** Profiling is DEV-only — zero overhead (pure passthrough) in production. */
const PROFILING_ENABLED = envGet('NODE_ENV') !== 'production';

/** Add `ms` under `name` into the active request store. No-op off the request path. */
export function record(name: string, ms: number): void {
  const store = timingStore.getStore();
  if (!store) return;
  store.set(name, (store.get(name) ?? 0) + ms);
}

/** Time `fn`, accumulating its wall-clock duration (ms) under `name`. */
export async function time<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    record(name, performance.now() - start);
  }
}

const NON_TOKEN = /[^\w-]/g;

/**
 * Serialize a store to a `Server-Timing` header value:
 * `name;dur=12.3, name2;dur=4`. Defaults to the active request store.
 */
export function serializeServerTiming(
  store: TimingStore | undefined = timingStore.getStore(),
): string {
  if (!store || store.size === 0) return '';
  const parts: string[] = [];
  for (const [name, ms] of store) {
    parts.push(`${name.replace(NON_TOKEN, '_')};dur=${Math.round(ms * 10) / 10}`);
  }
  return parts.join(', ');
}

/**
 * Profile an async phase for BOTH observability surfaces at once: accumulates
 * wall-clock duration into the active Server-Timing store (when `timingMiddleware`
 * is installed) AND emits a structured `[PROFILE]` log line via the provided
 * logger. `meta` is merged into the log data so callers can attach `operation`,
 * `graphId`, `model`, etc. — anything grep-able.
 *
 * DEV-only: in production this is a zero-overhead passthrough (no `performance.now`,
 * no log dispatch). Off the request path (no middleware), `record` is a no-op
 * but the log line still fires, so this works in background jobs, tests, and
 * CLI tools too.
 */
export async function profile<T>(
  logger: Pick<Logger, 'debug'>,
  phase: string,
  fn: () => Promise<T> | T,
  meta?: LogData,
): Promise<T> {
  if (!PROFILING_ENABLED) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const elapsedMs = Math.round((performance.now() - start) * 10) / 10;
    record(phase, elapsedMs);
    logger.debug(`[PROFILE] ${phase}`, { elapsedMs, ...meta });
  }
}

/**
 * Express/connect-style middleware: runs the request inside a fresh timing store
 * and emits the accumulated measures as a `Server-Timing` header on the way out.
 */
export function timingMiddleware(
  _req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  timingStore.run(new Map<string, number>(), () => {
    const start = performance.now();
    const originalEnd = res.end;
    // Inject the header right before the first flush. `res.end` is an overloaded
    // method, so reassigning it needs one precise assertion (not any/unknown).
    res.end = ((...args: Parameters<typeof originalEnd>) => {
      record('total', performance.now() - start);
      if (!res.headersSent) {
        const header = serializeServerTiming();
        if (header) res.setHeader('Server-Timing', header);
      }
      return originalEnd.apply(res, args);
    }) as typeof res.end;
    next();
  });
}
