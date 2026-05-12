/**
 * Optional localStorage persistence for the runtime knobs.
 *
 * Disabled by default — must be explicitly enabled by the consumer
 * (typically once at app entry). When enabled:
 * - On enable: reads the stored prefs blob and applies it via
 *   `setRuntimeNamespaceFilter` / `setLogLevel` / `setNamespaceLevel`.
 * - On every config change (via the observer hook): writes the current
 *   state back to localStorage under the same key.
 *
 * Browser-only. In Node (no `localStorage`), enable is a no-op.
 */

import { onLogConfigChange } from './observers.js';
import {
  getLogLevel,
  setLogLevel,
  getNamespaceLevels,
  setNamespaceLevel,
  type LogLevel,
} from './logger.js';
import {
  getRuntimeNamespaceFilter,
  setRuntimeNamespaceFilter,
} from './runtime-override.js';

const DEFAULT_KEY = 'almadar:logger:prefs';

interface StoredPrefs {
  namespaceFilter?: string;
  level?: LogLevel;
  namespaceLevels?: Record<string, LogLevel>;
}

let persistenceKey: string | null = null;
let unsubscribe: (() => void) | null = null;

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Some environments throw on `localStorage` access (sandboxed iframes,
    // Safari private mode in older versions). Treat as unavailable.
  }
  return null;
}

function write(): void {
  if (persistenceKey === null) return;
  const storage = getStorage();
  if (storage === null) return;
  const prefs: StoredPrefs = {
    namespaceFilter: getRuntimeNamespaceFilter(),
    level: getLogLevel(),
    namespaceLevels: Object.fromEntries(getNamespaceLevels()),
  };
  try {
    storage.setItem(persistenceKey, JSON.stringify(prefs));
  } catch {
    // Quota exceeded or storage disabled mid-session. Silent — logging
    // must never throw from its own observer.
  }
}

function read(): StoredPrefs | null {
  if (persistenceKey === null) return null;
  const storage = getStorage();
  if (storage === null) return null;
  try {
    const raw = storage.getItem(persistenceKey);
    if (raw === null) return null;
    return JSON.parse(raw) as StoredPrefs;
  } catch {
    return null;
  }
}

/**
 * Enable localStorage-backed persistence for the runtime knobs.
 *
 * Restores any previously saved prefs and starts mirroring future
 * mutations of namespace filter / level / namespace-level overrides
 * back to localStorage. Idempotent: subsequent calls reset the key and
 * re-bind the observer.
 *
 * @param key  localStorage key (default `'almadar:logger:prefs'`).
 */
export function enableLogPersistence(key: string = DEFAULT_KEY): void {
  persistenceKey = key;
  // Restore stored prefs first.
  const stored = read();
  if (stored !== null) {
    if (stored.namespaceFilter !== undefined) {
      setRuntimeNamespaceFilter(stored.namespaceFilter);
    }
    if (stored.level !== undefined) {
      setLogLevel(stored.level);
    }
    if (stored.namespaceLevels !== undefined) {
      for (const [ns, lvl] of Object.entries(stored.namespaceLevels)) {
        setNamespaceLevel(ns, lvl);
      }
    }
  }
  // Then subscribe future changes.
  if (unsubscribe !== null) unsubscribe();
  unsubscribe = onLogConfigChange(write);
}

/** Stop mirroring config changes to localStorage. Does NOT clear stored prefs. */
export function disableLogPersistence(): void {
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
  persistenceKey = null;
}

/** Clear the stored prefs blob (and stop persistence). */
export function clearLogPersistence(key: string = DEFAULT_KEY): void {
  const storage = getStorage();
  if (storage !== null) {
    try {
      storage.removeItem(key);
    } catch {
      // ignore
    }
  }
  disableLogPersistence();
}
