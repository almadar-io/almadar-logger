/**
 * Runtime namespace filter override.
 *
 * Read on every `Logger` method invocation so authors can flip filtering
 * from a browser console (or a Node REPL) without rebuilding:
 *
 *   globalThis.__ALMADAR_DEBUG__ = 'almadar:runtime:sm';   // narrow
 *   globalThis.__ALMADAR_DEBUG__ = '*';                    // verbose
 *   globalThis.__ALMADAR_DEBUG__ = '';                     // silence all DEBUG/INFO
 *   delete globalThis.__ALMADAR_DEBUG__;                   // fall back to env filter
 *
 * `undefined` = no override (env `ALMADAR_DEBUG` wins).
 * `'' (empty)` = explicit silence (overrides env).
 * Any non-empty string = comma-separated patterns, same wildcard semantics
 *                       as the env filter (`'*'`, `'almadar:*'`,
 *                       `'almadar:runtime:*'`, exact match).
 */

import { notifyLogConfigChange } from './observers.js';

declare global {
  var __ALMADAR_DEBUG__: string | undefined;
}

export function getRuntimeNamespaceFilter(): string | undefined {
  const g = globalThis as { __ALMADAR_DEBUG__?: string };
  return g.__ALMADAR_DEBUG__;
}

export function setRuntimeNamespaceFilter(value: string | undefined): void {
  const g = globalThis as { __ALMADAR_DEBUG__?: string };
  if (value === undefined) {
    delete g.__ALMADAR_DEBUG__;
  } else {
    g.__ALMADAR_DEBUG__ = value;
  }
  notifyLogConfigChange();
}
