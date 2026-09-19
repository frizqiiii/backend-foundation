import express from 'express';
import request from 'supertest';
import { createRateLimiter } from './rate-limiter';
import { errorHandler } from '../middlewares/error-handler';

function buildTestApp(limiter: ReturnType<typeof createRateLimiter>) {
  const app = express();
  app.use(limiter);
  app.get('/ping', (_req, res) => res.status(200).json({ success: true, data: 'pong' }));
  app.use(errorHandler);
  return app;
}

describe('createRateLimiter', () => {
  it('meloloskan request selama masih di bawah batas max', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 3,
      message: 'Terlalu banyak permintaan',
      keyPrefix: 'test-under-limit',
    });
    const app = buildTestApp(limiter);

    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.headers).toHaveProperty('ratelimit-limit');
  });

  it('P5 — membalas 429 lewat errorHandler terpusat (BUKAN format bawaan express-rate-limit) begitu batas max terlampaui', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 2,
      message: 'Terlalu banyak permintaan dari IP ini',
      keyPrefix: 'test-over-limit',
    });
    const app = buildTestApp(limiter);

    await request(app).get('/ping');
    await request(app).get('/ping');
    const res = await request(app).get('/ping');

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      message: 'Terlalu banyak permintaan dari IP ini',
    });
  });

  it('item 2.11 — `max` boleh berupa FUNGSI yang dievaluasi PER REQUEST (kuota bisa bergantung plan tenant aktif)', async () => {
    // Dua "tenant" dibedakan lewat header, masing-masing punya kuota berbeda
    // (mirip FREE vs ENTERPRISE) tapi memakai SATU limiter yang sama.
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: (req) => (req.headers['x-plan'] === 'ENTERPRISE' ? 3 : 1),
      message: 'Terlalu banyak permintaan',
      keyPrefix: 'test-dynamic-max',
      keyGenerator: (req) => String(req.headers['x-tenant']),
    });
    const app = buildTestApp(limiter);

    // Tenant FREE-like: kuota 1 -> request ke-2 ditolak.
    expect(
      (await request(app).get('/ping').set('x-tenant', 't-free').set('x-plan', 'FREE')).status
    ).toBe(200);
    expect(
      (await request(app).get('/ping').set('x-tenant', 't-free').set('x-plan', 'FREE')).status
    ).toBe(429);

    // Tenant ENTERPRISE-like: kuota 3 -> 3 request lolos, ke-4 ditolak.
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/ping')
        .set('x-tenant', 't-ent')
        .set('x-plan', 'ENTERPRISE');
      expect(res.status).toBe(200);
    }
    expect(
      (await request(app).get('/ping').set('x-tenant', 't-ent').set('x-plan', 'ENTERPRISE')).status
    ).toBe(429);
  });

  it('item 2.11 — header RateLimit-Limit mencerminkan kuota dinamis milik request itu (klien bisa tahu kuota tier-nya)', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: () => 42,
      message: 'Terlalu banyak permintaan',
      keyPrefix: 'test-dynamic-header',
    });
    const app = buildTestApp(limiter);

    const res = await request(app).get('/ping');

    expect(res.headers['ratelimit-limit']).toBe('42');
  });

  it('P5 — keyGenerator kustom (mis. per-tenant) dipakai kalau diberikan', async () => {
    const keyGenerator = jest.fn().mockReturnValue('tenant-abc');
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 5,
      message: 'x',
      keyPrefix: 'test-keygen',
      keyGenerator,
    });
    const app = buildTestApp(limiter);

    await request(app).get('/ping');

    expect(keyGenerator).toHaveBeenCalled();
  });

  it('P5 — skip kustom melewati limiter sepenuhnya kalau mengembalikan true (mis. tidak ada tenant context aktif)', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      message: 'harusnya tidak pernah terpicu',
      keyPrefix: 'test-skip',
      skip: () => true,
    });
    const app = buildTestApp(limiter);

    // Lebih dari `max`, tapi karena skip selalu true, tidak pernah 429.
    await request(app).get('/ping');
    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
  });

  it('P5 — memakai RedisStore (bukan MemoryStore default) kalau redisClient dikonfigurasi, dan sendCommand meneruskan ke redis.call dengan benar', async () => {
    let mod: typeof import('./rate-limiter') | undefined;
    const redisCall = jest.fn().mockResolvedValue('OK');
    let capturedSendCommand: ((...args: string[]) => unknown) | undefined;

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../config/redis', () => ({ redisClient: { call: redisCall } }));
      jest.doMock('rate-limit-redis', () => ({
        RedisStore: jest
          .fn()
          .mockImplementation((opts: { sendCommand: typeof capturedSendCommand }) => {
            capturedSendCommand = opts.sendCommand;
            return {
              init: jest.fn(),
              increment: jest.fn().mockResolvedValue({ totalHits: 1, resetTime: undefined }),
              decrement: jest.fn(),
              resetKey: jest.fn(),
              // Bentuk asli `RedisStore` (lihat rate-limiter.ts): constructor
              // sungguhan meng-eager-load 2 Lua script lewat property
              // public ini (masing-masing sebuah Promise). Kode kita
              // memasang `.catch()` no-op pada keduanya SEGERA setelah
              // instance dibuat (fix untuk bug upstream rate-limit-redis
              // #190) — mock ini harus punya bentuk yang sama supaya
              // `.catch()` itu tidak meledak kena `undefined`.
              incrementScriptSha: Promise.resolve('mock-sha-increment'),
              getScriptSha: Promise.resolve('mock-sha-get'),
            };
          }),
      }));
      mod = require('./rate-limiter');
    });

    mod!.createRateLimiter({
      windowMs: 60_000,
      max: 5,
      message: 'x',
      keyPrefix: 'test-redis-store',
    });

    expect(capturedSendCommand).toBeDefined();
    await capturedSendCommand!('INCR', 'rate_limit:test-redis-store:1.2.3.4');

    expect(redisCall).toHaveBeenCalledWith('INCR', 'rate_limit:test-redis-store:1.2.3.4');
  });

  it('P5 — Insiden nyata (verifikasi graceful shutdown, Fase 1 item 1.5): kalau RedisStore.increment() gagal (mis. Redis down), request TETAP lolos 200 (fail-open), BUKAN 500 — passOnStoreError:true mencegah SATU dependency opsional yang down menjatuhkan SELURUH endpoint', async () => {
    let mod: typeof import('./rate-limiter') | undefined;

    await jest.isolateModulesAsync(async () => {
      jest.doMock('../config/redis', () => ({ redisClient: { call: jest.fn() } }));
      jest.doMock('rate-limit-redis', () => ({
        RedisStore: jest.fn().mockImplementation(() => ({
          init: jest.fn(),
          increment: jest
            .fn()
            .mockRejectedValue(
              new Error(
                'MaxRetriesPerRequestError: Reached the max retries per request limit (which is 2).'
              )
            ),
          decrement: jest.fn(),
          resetKey: jest.fn(),
          incrementScriptSha: Promise.resolve('mock-sha-increment'),
          getScriptSha: Promise.resolve('mock-sha-get'),
        })),
      }));
      mod = require('./rate-limiter');
    });

    const limiter = mod!.createRateLimiter({
      windowMs: 60_000,
      max: 5,
      message: 'x',
      keyPrefix: 'test-store-error-fail-open',
    });
    const app = buildTestApp(limiter);

    const res = await request(app).get('/ping');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: 'pong' });
  });
});
