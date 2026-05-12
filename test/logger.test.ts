import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type ConsoleSpy = ReturnType<typeof vi.spyOn>;
type Spies = { debug: ConsoleSpy; info: ConsoleSpy; warn: ConsoleSpy; error: ConsoleSpy };

function installConsoleSpies(): Spies {
  return {
    debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
    info:  vi.spyOn(console, 'info').mockImplementation(() => {}),
    warn:  vi.spyOn(console, 'warn').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
  };
}

function restoreSpies(spies: Spies): void {
  spies.debug.mockRestore();
  spies.info.mockRestore();
  spies.warn.mockRestore();
  spies.error.mockRestore();
}

async function freshImport(env: Partial<Record<'NODE_ENV' | 'LOG_LEVEL' | 'ALMADAR_DEBUG', string>>) {
  vi.resetModules();
  const original = { ...process.env };
  for (const key of ['NODE_ENV', 'LOG_LEVEL', 'ALMADAR_DEBUG'] as const) {
    if (env[key] !== undefined) process.env[key] = env[key];
    else delete process.env[key];
  }
  const mod = await import('../src/index.js');
  const restore = () => {
    for (const key of ['NODE_ENV', 'LOG_LEVEL', 'ALMADAR_DEBUG'] as const) {
      if (original[key] !== undefined) process.env[key] = original[key];
      else delete process.env[key];
    }
  };
  return { ...mod, restore };
}

describe('createLogger', () => {
  let spies: Spies;

  beforeEach(() => { spies = installConsoleSpies(); });
  afterEach(() => {
    restoreSpies(spies);
    const g = globalThis as { __ALMADAR_DEBUG__?: string };
    delete g.__ALMADAR_DEBUG__;
  });

  it('fires all four levels by default in development', async () => {
    const { createLogger, restore } = await freshImport({ NODE_ENV: 'development' });
    const log = createLogger('almadar:test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(spies.debug).toHaveBeenCalledTimes(1);
    expect(spies.info).toHaveBeenCalledTimes(1);
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
    restore();
  });

  it('production default suppresses DEBUG and INFO (tightened from old INFO default)', async () => {
    const { createLogger, restore } = await freshImport({ NODE_ENV: 'production' });
    const log = createLogger('almadar:test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledTimes(1);
    expect(spies.error).toHaveBeenCalledTimes(1);
    restore();
  });

  it('LOG_LEVEL=info in production allows INFO too', async () => {
    const { createLogger, restore } = await freshImport({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    const log = createLogger('almadar:test');
    log.debug('d');
    log.info('i');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledTimes(1);
    restore();
  });

  it('LOG_LEVEL=error suppresses everything below ERROR in dev', async () => {
    const { createLogger, restore } = await freshImport({ NODE_ENV: 'development', LOG_LEVEL: 'error' });
    const log = createLogger('almadar:test');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledTimes(1);
    restore();
  });

  describe('namespace gate (env filter)', () => {
    it('exact match', async () => {
      const { createLogger, restore } = await freshImport({ ALMADAR_DEBUG: 'almadar:foo' });
      createLogger('almadar:foo').debug('hit');
      createLogger('almadar:bar').debug('miss');
      expect(spies.debug).toHaveBeenCalledTimes(1);
      restore();
    });

    it('wildcard prefix', async () => {
      const { createLogger, restore } = await freshImport({ ALMADAR_DEBUG: 'almadar:runtime:*' });
      createLogger('almadar:runtime:sm').debug('hit');
      createLogger('almadar:runtime:effects').debug('hit');
      createLogger('almadar:ui:flow').debug('miss');
      expect(spies.debug).toHaveBeenCalledTimes(2);
      restore();
    });

    it('comma list', async () => {
      const { createLogger, restore } = await freshImport({ ALMADAR_DEBUG: 'almadar:a,almadar:b' });
      createLogger('almadar:a').debug('hit');
      createLogger('almadar:b').debug('hit');
      createLogger('almadar:c').debug('miss');
      expect(spies.debug).toHaveBeenCalledTimes(2);
      restore();
    });

    it('star = all', async () => {
      const { createLogger, restore } = await freshImport({ ALMADAR_DEBUG: '*' });
      createLogger('any:thing').debug('hit');
      createLogger('almadar:any').debug('hit');
      expect(spies.debug).toHaveBeenCalledTimes(2);
      restore();
    });

    it('namespace gate only restricts DEBUG and INFO; WARN/ERROR always fire', async () => {
      const { createLogger, restore } = await freshImport({ ALMADAR_DEBUG: 'almadar:included' });
      const excluded = createLogger('almadar:excluded');
      excluded.debug('d');
      excluded.info('i');
      excluded.warn('w');
      excluded.error('e');
      expect(spies.debug).not.toHaveBeenCalled();
      expect(spies.info).not.toHaveBeenCalled();
      expect(spies.warn).toHaveBeenCalledTimes(1);
      expect(spies.error).toHaveBeenCalledTimes(1);
      restore();
    });
  });

  describe('runtime override (globalThis.__ALMADAR_DEBUG__)', () => {
    it('overrides env filter — narrows on each call without restart', async () => {
      const { createLogger, setRuntimeNamespaceFilter, restore } =
        await freshImport({ NODE_ENV: 'development', ALMADAR_DEBUG: '*' });

      const sm = createLogger('almadar:runtime:sm');
      const ui = createLogger('almadar:ui:flow');

      sm.debug('1');
      ui.debug('2');
      expect(spies.debug).toHaveBeenCalledTimes(2);

      setRuntimeNamespaceFilter('almadar:runtime:sm');
      sm.debug('3');
      ui.debug('4');
      expect(spies.debug).toHaveBeenCalledTimes(3);

      setRuntimeNamespaceFilter(undefined);
      sm.debug('5');
      ui.debug('6');
      expect(spies.debug).toHaveBeenCalledTimes(5);
      restore();
    });

    it('empty string silences DEBUG/INFO even with verbose env filter', async () => {
      const { createLogger, setRuntimeNamespaceFilter, restore } =
        await freshImport({ NODE_ENV: 'development', ALMADAR_DEBUG: '*' });
      setRuntimeNamespaceFilter('');
      const log = createLogger('almadar:anything');
      log.debug('d');
      log.info('i');
      log.warn('w');
      expect(spies.debug).not.toHaveBeenCalled();
      expect(spies.info).not.toHaveBeenCalled();
      expect(spies.warn).toHaveBeenCalledTimes(1);
      restore();
    });
  });

  describe('lazy thunk', () => {
    it('thunk not invoked when level filters out', async () => {
      const { createLogger, restore } = await freshImport({ NODE_ENV: 'production' });
      const log = createLogger('almadar:test');
      const thunk = vi.fn(() => ({ field: 1 }));
      log.debug('d', thunk);
      log.info('i', thunk);
      expect(thunk).not.toHaveBeenCalled();
      restore();
    });

    it('thunk invoked exactly once when level allows', async () => {
      const { createLogger, restore } = await freshImport({ NODE_ENV: 'development' });
      const log = createLogger('almadar:test');
      const thunk = vi.fn(() => ({ field: 42 }));
      log.debug('d', thunk);
      expect(thunk).toHaveBeenCalledTimes(1);
      expect(spies.debug).toHaveBeenCalledWith('[almadar:test]', 'd', { field: 42 });
      restore();
    });

    it('thunk not invoked when namespace filter rejects', async () => {
      const { createLogger, restore } =
        await freshImport({ NODE_ENV: 'development', ALMADAR_DEBUG: 'almadar:included' });
      const log = createLogger('almadar:excluded');
      const thunk = vi.fn(() => ({ field: 1 }));
      log.debug('d', thunk);
      expect(thunk).not.toHaveBeenCalled();
      restore();
    });
  });

  describe('correlation id', () => {
    it('attaches cid into the data payload', async () => {
      const { createLogger, generateCorrelationId, restore } =
        await freshImport({ NODE_ENV: 'development' });
      const log = createLogger('almadar:test');
      const cid = generateCorrelationId();
      log.info('msg', { x: 1 }, cid);
      expect(spies.info).toHaveBeenCalledWith('[almadar:test]', 'msg', { x: 1, cid });
      restore();
    });

    it('attaches cid even when data is omitted', async () => {
      const { createLogger, restore } = await freshImport({ NODE_ENV: 'development' });
      const log = createLogger('almadar:test');
      log.info('msg', undefined, 'abc');
      expect(spies.info).toHaveBeenCalledWith('[almadar:test]', 'msg', { cid: 'abc' });
      restore();
    });
  });
});
