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

/** name → accumulated milliseconds for the current request. */
export type TimingStore = Map<string, number>;

export const timingStore = new AsyncLocalStorage<TimingStore>();

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
