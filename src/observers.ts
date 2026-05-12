/**
 * Config-change observers. Persistence and debug-UI consumers subscribe
 * here so they can react to any mutation of the logger's runtime
 * configuration (level, namespace filter, per-namespace overrides).
 */

type Observer = () => void;

const observers = new Set<Observer>();

export function onLogConfigChange(fn: Observer): () => void {
  observers.add(fn);
  return () => {
    observers.delete(fn);
  };
}

export function notifyLogConfigChange(): void {
  for (const fn of observers) {
    try {
      fn();
    } catch {
      // Observer errors must not break log dispatch.
    }
  }
}
