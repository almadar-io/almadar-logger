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
  getRuntimeNamespaceFilter,
  setRuntimeNamespaceFilter,
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
