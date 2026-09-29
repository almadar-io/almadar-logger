/**
 * A hosted app writes one structured JSON line per log entry (Cloud Logging's shape) so its
 * deployment topology can be read back: which stores, integrations and servers it called, how
 * often, how fast and how many failed. Console output stays the default and is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isStructuredLogEntry, type JsonValue } from '@almadar/core';

type LogSpy = ReturnType<typeof vi.spyOn>;

async function fresh(env: Partial<Record<'ALMADAR_DEBUG' | 'ALMADAR_LOG_FORMAT' | 'NODE_ENV', string>> = {}) {
  vi.resetModules();
  const saved = { ...process.env };
  for (const key of ['ALMADAR_DEBUG', 'ALMADAR_LOG_FORMAT', 'NODE_ENV'] as const) {
    if (env[key] !== undefined) process.env[key] = env[key];
    else delete process.env[key];
  }
  const mod = await import('../src/index.js');
  const restore = () => {
    for (const key of ['ALMADAR_DEBUG', 'ALMADAR_LOG_FORMAT', 'NODE_ENV'] as const) {
      if (saved[key] !== undefined) process.env[key] = saved[key];
      else delete process.env[key];
    }
  };
  return { ...mod, restore };
}

function lines(spy: LogSpy): JsonValue[] {
  return spy.mock.calls.map((args) => {
    const parsed: JsonValue = JSON.parse(String(args[0]));
    return parsed;
  });
}

describe('structured (json) log output', () => {
  let log: LogSpy;
  let info: LogSpy;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    info.mockRestore();
  });

  it('writes one Cloud Logging line per entry, with severity, namespace, data and the deployment context', async () => {
    const m = await fresh();
    m.configureLogOutput({ format: 'json', context: { appId: 'app-1', deploymentCommit: 'abc' } });
    m.createLogger('almadar:host').warn('slow', { ms: 1200 });
    const [line] = lines(log);
    expect(isStructuredLogEntry(line)).toBe(true);
    expect(line).toMatchObject({ severity: 'WARNING', namespace: 'almadar:host', message: 'slow', data: { ms: 1200 }, appId: 'app-1', deploymentCommit: 'abc' });
    expect(info).not.toHaveBeenCalled();
    m.restore();
  });

  it('records a call, and timeCall measures a success and a failure (rethrowing it)', async () => {
    const m = await fresh();
    m.configureLogOutput({ format: 'json', context: { appId: 'app-1' } });
    const logger = m.createLogger('almadar:server:data');
    m.createLogger('almadar:host').call({ kind: 'server', service: 'host', op: 'GET /', durationMs: 3, ok: true });
    await expect(m.timeCall(logger, { kind: 'db', service: 'firestore', op: 'list:Order' }, async () => 7)).resolves.toBe(7);
    await expect(m.timeCall(logger, { kind: 'external', service: 'stripe', op: 'charge' }, async () => { throw new Error('card declined'); })).rejects.toThrow('card declined');
    const calls = lines(log).map((l) => (isStructuredLogEntry(l) ? l.call : undefined));
    expect(calls.map((c) => c && [c.kind, c.service, c.op, c.ok])).toEqual([
      ['server', 'host', 'GET /', true],
      ['db', 'firestore', 'list:Order', true],
      ['external', 'stripe', 'charge', false],
    ]);
    expect(calls[2]?.error).toBe('card declined');
    expect(calls.every((c) => c !== undefined && c.durationMs >= 0)).toBe(true);
    m.restore();
  });

  it('call records are telemetry: a namespace filter that hides INFO does not hide them', async () => {
    const m = await fresh({ ALMADAR_DEBUG: 'almadar:ui:*' });
    m.configureLogOutput({ format: 'json' });
    const logger = m.createLogger('almadar:server:data');
    logger.info('hidden by the filter');
    logger.call({ kind: 'db', service: 'firestore', op: 'get:Order', durationMs: 1, ok: true });
    expect(lines(log)).toHaveLength(1);
    m.restore();
  });

  it('edge: an Error, a Date and an undefined value in data serialize to JSON faithfully', async () => {
    const m = await fresh();
    m.configureLogOutput({ format: 'json' });
    m.createLogger('n').error('boom', { err: new Error('bad'), at: new Date('2026-09-29T00:00:00.000Z'), gone: undefined });
    const [line] = lines(log);
    expect(line).toMatchObject({ severity: 'ERROR', data: { err: { name: 'Error', message: 'bad' }, at: '2026-09-29T00:00:00.000Z' } });
    expect(isStructuredLogEntry(line) && line.data && 'gone' in line.data).toBe(false);
    m.restore();
  });

  it('a sink receives every structured entry as well, e.g. a local host keeping each app\'s log', async () => {
    const m = await fresh();
    const seen: string[] = [];
    m.configureLogOutput({ format: 'json', context: { appId: 'app-1' }, sink: (entry) => { seen.push(`${entry.appId ?? ''}:${entry.call?.op ?? entry.message}`); } });
    m.createLogger('n').warn('one');
    m.createLogger('n').call({ kind: 'db', service: 'memory', op: 'list:Item', durationMs: 1, ok: true });
    expect(seen).toEqual(['app-1:one', 'app-1:list:Item']);
    expect(lines(log)).toHaveLength(2);
    m.restore();
  });

  it('control: in console format no sink is called', async () => {
    const m = await fresh();
    const seen: string[] = [];
    m.configureLogOutput({ format: 'console', sink: (entry) => { seen.push(entry.message); } });
    m.createLogger('n').warn('console only');
    expect(seen).toEqual([]);
    m.restore();
  });

  it('a per-request context (one process serving many apps) overrides the static one on each line', async () => {
    const m = await fresh();
    let current: { appId: string; deploymentCommit: string } | undefined;
    m.configureLogOutput({ format: 'json', context: { appId: 'static' }, contextOf: () => current });
    const logger = m.createLogger('almadar:server:data');
    current = { appId: 'app-a', deploymentCommit: 'ca' };
    logger.call({ kind: 'db', service: 'firestore', op: 'list:Order', durationMs: 1, ok: true });
    current = { appId: 'app-b', deploymentCommit: 'cb' };
    logger.call({ kind: 'db', service: 'firestore', op: 'list:Order', durationMs: 1, ok: true });
    current = undefined;
    logger.warn('outside any request');
    expect(lines(log).map((l) => (isStructuredLogEntry(l) ? l.appId : null))).toEqual(['app-a', 'app-b', 'static']);
    m.restore();
  });

  it('ALMADAR_LOG_FORMAT=json selects the structured output at startup', async () => {
    const m = await fresh({ ALMADAR_LOG_FORMAT: 'json' });
    m.createLogger('n').warn('w');
    expect(isStructuredLogEntry(lines(log)[0])).toBe(true);
    m.restore();
  });

  it('control: the default console output is unchanged, and a call is logged as INFO through the filter', async () => {
    const m = await fresh({ ALMADAR_DEBUG: 'almadar:ui:*' });
    const logger = m.createLogger('almadar:server:data');
    logger.call({ kind: 'db', service: 'firestore', op: 'get:Order', durationMs: 1, ok: true });
    m.createLogger('almadar:ui:x').call({ kind: 'client', service: 'ui', op: 'x', durationMs: 1, ok: true });
    expect(log).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toBe('[almadar:ui:x]');
    m.restore();
  });
});
