import { describe, it, expect } from 'vitest';
import { createServer, get } from 'node:http';
import {
  timingStore,
  time,
  record,
  serializeServerTiming,
  timingMiddleware,
} from '../src/timing.js';

describe('timing core', () => {
  it('accumulates time() and record() into the active store', async () => {
    await timingStore.run(new Map(), async () => {
      await time('work', async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      record('extra', 2);
      record('extra', 3);
      const store = timingStore.getStore();
      expect(store?.get('work')).toBeGreaterThanOrEqual(4);
      expect(store?.get('extra')).toBe(5);
      const header = serializeServerTiming();
      expect(header).toMatch(/work;dur=/);
      expect(header).toContain('extra;dur=5');
    });
  });

  it('time()/record() are safe no-ops off the request path', async () => {
    const out = await time('x', async () => 42);
    expect(out).toBe(42);
    record('y', 3);
    expect(serializeServerTiming()).toBe('');
  });

  it('sanitizes names to the Server-Timing token grammar', async () => {
    await timingStore.run(new Map(), async () => {
      record('orb subprocess', 10);
      expect(serializeServerTiming()).toContain('orb_subprocess;dur=10');
    });
  });

  it('middleware emits a Server-Timing header with the request stages', async () => {
    const server = createServer((req, res) => {
      timingMiddleware(req, res, () => {
        record('handler', 7);
        res.statusCode = 200;
        res.end('ok');
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, resolve));
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const header = await new Promise<string>((resolve, reject) => {
        get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume();
          resolve(String(res.headers['server-timing'] ?? ''));
        }).on('error', reject);
      });
      expect(header).toContain('handler;dur=7');
      expect(header).toMatch(/total;dur=/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
