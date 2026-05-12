# @almadar/logger

Shared structured-logging gate for `@almadar/*` packages. Strict types
(`LogMeta` from `@almadar/core`), three-layer gating
(compile-time / env / runtime override), and zero React deps. Works in
Node, Vite, Webpack, and plain browsers.

```ts
import { createLogger } from '@almadar/logger';

const log = createLogger('almadar:runtime:sm');

log.debug('transition', { from: 'idle', to: 'loading', event: 'FETCH' });
log.info('saved', { id: 42 });
log.warn('rate limited');
log.error('persist failed', { code: 'EPERSIST' });
```

## Public API

```ts
import type { LogLevel, Logger, LogData } from '@almadar/logger';
import {
  createLogger,
  generateCorrelationId,
  // runtime tuning
  getLogLevel,
  setLogLevel,
  setNamespaceLevel,
  getNamespaceLevel,
  getNamespaceLevels,
  isLogLevelEnabled,
  getRuntimeNamespaceFilter,
  setRuntimeNamespaceFilter,
  // persistence + observation
  enableLogPersistence,
  disableLogPersistence,
  clearLogPersistence,
  onLogConfigChange,
} from '@almadar/logger';
```

- `LogLevel` = `'DEBUG' | 'INFO' | 'WARN' | 'ERROR'`.
- `LogData` = `LogMeta | (() => LogMeta)`. Pass a thunk to defer payload
  construction until after the gate decides to fire.
- `Logger` has `debug`, `info`, `warn`, `error` methods, each taking
  `(message, data?, correlationId?)`.
- `generateCorrelationId()` returns `evt-<ts>-<n>` strings for tracing
  related lines.

## Three-layer gate

1. **Compile-time default** (read once at module load):
   `NODE_ENV=production` → `MIN_PRIORITY=WARN`. Otherwise DEBUG.
   `LOG_LEVEL=info|debug|warn|error` overrides in both cases.
2. **Env namespace filter** (read once):
   `ALMADAR_DEBUG="almadar:runtime:*,almadar:ui:flow-canvas"`.
   Supports `*`, `prefix:*`, comma-separated exact matches.
3. **Runtime namespace override** (re-read each call):
   `globalThis.__ALMADAR_DEBUG__`. `undefined` = fall back to layer 2,
   `''` = silence all DEBUG/INFO regardless, `'*'` = enable everywhere.

Only DEBUG and INFO go through layers 2 and 3 — WARN and ERROR always
fire if they pass layer 1.

## Lazy thunks

When the level filters a call out, the thunk is never evaluated. This
lets hot paths shed object-construction cost even when callers don't
manually guard:

```ts
log.debug('emit', () => ({
  type,
  payloadKeys: Object.keys(payload),
  listenerCount: bus.listenerCount(type),
}));
```

In production with `NODE_ENV=production` (level forced to WARN), the
thunk above costs one comparison and an early return.

## Runtime toggle from a browser console

```js
globalThis.__ALMADAR_DEBUG__ = 'almadar:runtime:sm';   // narrow filter
globalThis.__ALMADAR_DEBUG__ = '*';                    // verbose
globalThis.__ALMADAR_DEBUG__ = '';                     // silence DEBUG/INFO
delete globalThis.__ALMADAR_DEBUG__;                   // restore env filter
```

The override re-reads on every `Logger` method call, so flips take
effect immediately without restart or rebuild.

## Level policy (which method to call)

Pick the level by **how often the call site fires** and **how much
work the payload costs to build**. The contract: production sets
`LOG_LEVEL=info` (or leaves the default at WARN) and expects that to
be cheap. So anything frequent or heavy belongs at DEBUG, gated under
an explicit operator opt-in.

| Level | Use for | Frequency budget | Examples |
|---|---|---|---|
| `error` | Caught exception, contract violated, operation failed unrecoverably. | Any. | persist failed; listener threw; SExpr returned wrong shape. |
| `warn` | Recoverable issue, fallback fired, drift detected. | Any. | emit with zero listeners; rate-limited retry; cache miss in nominally-hot path. |
| `info` | One-shot lifecycle event or user-initiated business action. | **O(1) per user action.** Never per render, never per emit, never per transition. | App start; integration init; entity create/update/delete; auth success; route mount. |
| `debug` | Hot-path diagnostic. Fires per emit, per render, per transition, per binding interpolation, per effect dispatch. | Unlimited. Production filters it out by level; namespace gates further. | EventBus.emit; trait transition; SExpr eval; render-ui dispatch; slot write; binding resolve. |

**The lazy-thunk rule:** if the data argument contains
`JSON.stringify`, `Object.keys` on something potentially large, an
`Array.map` over more than a handful of items, or any other O(N) work,
wrap the data argument in a thunk. This applies even to INFO calls —
WARN-only production still skips the thunk:

```ts
// BAD: stringify runs on every event, even when filtered out
log.debug('processEvent', { event, payload: JSON.stringify(payload) });

// GOOD: stringify only runs when DEBUG actually fires
log.debug('processEvent', () => ({ event, payload: JSON.stringify(payload) }));
```

**When in doubt, use DEBUG.** Promoting a DEBUG call to INFO later is
trivial; demoting an INFO call after it's already shipped means the
log volume spike was already on someone's bill.

## Consumer-side tuning

Six knobs, in priority order at every log call:

1. **`setNamespaceLevel(pattern, level)`** — per-namespace priority
   floor. Use to bring a noisy namespace below the global threshold,
   or to enable just one namespace at DEBUG while everything else
   stays at WARN. Pattern accepts exact namespaces or `prefix:*`.
   ```ts
   setNamespaceLevel('almadar:runtime:sm', 'DEBUG');   // only this
   setNamespaceLevel('almadar:ui:flow-canvas', 'WARN'); // quiet a noisy one
   setNamespaceLevel('almadar:runtime:*', null);        // clear override
   ```

2. **`setLogLevel(level)`** — global priority floor at runtime. The
   env-based `LOG_LEVEL` only sets the *initial* value; this lets you
   flip it from a settings UI or a feature flag without restarting.
   ```ts
   setLogLevel('DEBUG'); // app-wide turn on
   ```

3. **`setRuntimeNamespaceFilter(pattern)`** — the namespace allowlist
   (DEBUG/INFO only — WARN/ERROR always pass). Same semantics as
   `globalThis.__ALMADAR_DEBUG__`.

4. **`enableLogPersistence(key?)`** — wires the above three knobs to
   `localStorage` so dev toggles survive page reloads. Idempotent;
   browser-only (no-op in Node).
   ```ts
   // app/main.tsx — once at entry
   enableLogPersistence();   // key defaults to 'almadar:logger:prefs'
   ```

5. **`isLogLevelEnabled(level, namespace)`** — read-only gate check.
   Use to skip an even-heavier diagnostic when the call site wouldn't
   fire anyway:
   ```ts
   if (isLogLevelEnabled('DEBUG', 'almadar:ui:flow')) {
     log.debug('expensive', deepProbeOfReactFiberTree());
   }
   ```

6. **`onLogConfigChange(fn)`** — observer for any of the above
   changing. Returns an unsubscribe. Use it to build a debug panel
   that reflects current state.

### Recommended consumer setup (apps/builder, playground, etc.)

```ts
// once at app entry — restores stored prefs and persists future flips
import { enableLogPersistence, setNamespaceLevel } from '@almadar/logger';
enableLogPersistence();

// e.g. silence one chatty namespace by default; users can re-enable from devtools
setNamespaceLevel('almadar:runtime:sm', 'WARN');
```

```ts
// settings UI — flip from a toggle
import { setLogLevel } from '@almadar/logger';
function onDebugModeToggle(enabled: boolean) {
  setLogLevel(enabled ? 'DEBUG' : 'INFO');
}
```
