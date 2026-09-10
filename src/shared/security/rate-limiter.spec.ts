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
});
