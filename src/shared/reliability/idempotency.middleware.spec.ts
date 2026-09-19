import type { Request, Response, NextFunction } from 'express';
import { idempotencyMiddleware } from './idempotency.middleware';
import { withLock } from '../concurrency/distributed-lock';
import { logger } from '../logger';

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('../concurrency/distributed-lock', () => ({
  withLock: jest.fn(),
}));

// `redisClient` bisa `null` (Redis tidak dikonfigurasi) — memakai getter
// supaya bisa diubah per-test tanpa perlu re-require modul.
let mockRedisClientValue: { get: jest.Mock; set: jest.Mock } | null = {
  get: jest.fn(),
  set: jest.fn(),
};
jest.mock('../config/redis', () => ({
  get redisClient() {
    return mockRedisClientValue;
  },
}));

const mockedWithLock = withLock as jest.Mock;

function createMockRequest(headers: Record<string, string> = {}, user?: { id: string }): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    user,
  } as unknown as Request;
}

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  // Otomatis memicu callback 'finish' segera — cukup untuk seluruh test
  // di sini (idempotencyMiddleware menunggu event ini sebelum melepas
  // lock, lihat `await new Promise<void>((resolve) => { res.once('finish', resolve); next(); })`
  // di source).
  res.once = jest.fn().mockImplementation((event: string, cb: () => void) => {
    if (event === 'finish') cb();
    return res;
  });
  return res;
}

describe('idempotencyMiddleware', () => {
  const middleware = idempotencyMiddleware({ scope: 'test-scope' });

  beforeEach(() => {
    mockRedisClientValue = { get: jest.fn(), set: jest.fn() };
  });

  it('langsung next() TANPA menyentuh Redis kalau tidak ada header Idempotency-Key', async () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockRedisClientValue!.get).not.toHaveBeenCalled();
  });

  it('P5 — FAIL-OPEN: langsung next() kalau Redis tidak dikonfigurasi (redisClient null)', async () => {
    mockRedisClientValue = null;
    const req = createMockRequest({ 'idempotency-key': 'key-1' });
    const res = createMockResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(mockedWithLock).not.toHaveBeenCalled();
  });

  it('membalas response yang di-cache (Idempotency-Replayed: true) TANPA memanggil withLock kalau cache sudah ada', async () => {
    mockRedisClientValue!.get.mockResolvedValue(
      JSON.stringify({ statusCode: 201, body: { success: true } })
    );
    const req = createMockRequest({ 'idempotency-key': 'key-1' }, { id: 'user-1' });
    const res = createMockResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Idempotency-Replayed', 'true');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true });
    expect(mockedWithLock).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('P5 — fail-open kalau Redis GET gagal (redis lambat/down): tetap lanjut lewat withLock, bukan menolak request', async () => {
    mockRedisClientValue!.get.mockRejectedValue(new Error('ECONNREFUSED'));
    mockedWithLock.mockImplementation(
      async (_key: string, _ttl: number, fn: () => Promise<void>) => {
        await fn();
        return { ran: true, result: undefined };
      }
    );
    const req = createMockRequest({ 'idempotency-key': 'key-2' });
    const res = createMockResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(mockedWithLock).toHaveBeenCalled();
    // Pastikan userId benar-benar fallback ke 'anonymous' (bukan string
    // kosong) saat request tidak punya req.user — sekaligus membuktikan
    // key yang dikirim ke withLock persis sesuai format yang didesain
    // (bukan cuma "dipanggil", tapi dipanggil dengan key yang benar).
    expect(mockedWithLock).toHaveBeenCalledWith(
      'idempotency:idempotency:test-scope:anonymous:key-2',
      expect.any(Number),
      expect.any(Function)
    );
    // Pastikan kegagalan Redis GET benar-benar di-log dengan detail
    // errornya (bukan cuma diam-diam ditelan) — bagian penting dari
    // filosofi fail-open: gagal tapi tetap KETAHUAN, bukan gagal senyap.
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), cacheKey: 'idempotency:test-scope:anonymous:key-2' },
      'IdempotencyMiddleware: gagal membaca cache Redis — fail-open'
    );
  });

  it('menjalankan handler (next) di dalam withLock kalau tidak ada cache, dan menyimpan response sukses ke Redis', async () => {
    mockRedisClientValue!.get.mockResolvedValue(null);
    mockRedisClientValue!.set.mockResolvedValue('OK');
    let capturedRunner: (() => Promise<void>) | undefined;
    mockedWithLock.mockImplementation(
      async (_key: string, _ttl: number, fn: () => Promise<void>) => {
        capturedRunner = fn;
        const result = await fn();
        return { ran: true, result };
      }
    );

    const req = createMockRequest({ 'idempotency-key': 'key-3' }, { id: 'user-1' });
    const res = createMockResponse();
    const next: NextFunction = jest.fn(() => {
      // Simulasikan controller yang langsung menjawab sukses.
      res.statusCode = 201;
      (res.json as jest.Mock)({ success: true, message: 'dibuat' });
    }) as unknown as NextFunction;
    (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
      if (event === 'finish') cb();
    });

    await middleware(req, res, next);

    expect(capturedRunner).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockRedisClientValue!.set).toHaveBeenCalledWith(
      expect.stringContaining('idempotency:test-scope:user-1:key-3'),
      JSON.stringify({ statusCode: 201, body: { success: true, message: 'dibuat' } }),
      'EX',
      86400 // 24 jam PERSIS (24*60*60) — bukan cuma "sebuah angka", supaya
      // mutasi pada rumus TTL-nya (mis. 24*60/60 atau 24/60) ketahuan.
    );
    // Path sukses (withLock mengembalikan ran:true) TIDAK BOLEH ikut
    // membalas 409 — 409 cuma untuk kasus request duplikat yang ditolak
    // withLock (ran:false), lihat test terpisah di bawah.
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  it('P5 — TIDAK menyimpan ke cache kalau response berstatus error (>= 400) — supaya kegagalan tetap bisa di-retry, bukan di-replay', async () => {
    mockRedisClientValue!.get.mockResolvedValue(null);
    mockedWithLock.mockImplementation(
      async (_key: string, _ttl: number, fn: () => Promise<void>) => {
        const result = await fn();
        return { ran: true, result };
      }
    );

    const req = createMockRequest({ 'idempotency-key': 'key-4' });
    const res = createMockResponse();
    const next: NextFunction = jest.fn(() => {
      res.statusCode = 422;
      (res.json as jest.Mock)({ success: false, message: 'invalid' });
    });
    (res.once as jest.Mock).mockImplementation((event: string, cb: () => void) => {
      if (event === 'finish') cb();
    });

    await middleware(req, res, next);

    expect(mockRedisClientValue!.set).not.toHaveBeenCalled();
  });

  it('P5 — fail-open kalau Redis SET (simpan cache) gagal: tetap membalas response asli ke client, hanya di-log', async () => {
    mockRedisClientValue!.get.mockResolvedValue(null);
    mockRedisClientValue!.set.mockRejectedValue(new Error('ECONNREFUSED saat SET'));
    mockedWithLock.mockImplementation(
      async (_key: string, _ttl: number, fn: () => Promise<void>) => {
        const result = await fn();
        return { ran: true, result };
      }
    );

    const req = createMockRequest({ 'idempotency-key': 'key-6' });
    const res = createMockResponse();
    const originalJsonMock = res.json as jest.Mock;
    const next: NextFunction = jest.fn(() => {
      res.statusCode = 200;
      res.json({ success: true });
    }) as unknown as NextFunction;

    await middleware(req, res, next);
    // Beri satu putaran microtask untuk `.catch()` internal (fire-and-
    // forget, tidak di-`await` oleh middleware) sempat berjalan.
    await new Promise(process.nextTick);

    expect(originalJsonMock).toHaveBeenCalledWith({ success: true });
  });

  it('membalas 409 kalau request lain dengan key yang sama sedang diproses bersamaan (withLock mengembalikan ran:false)', async () => {
    mockRedisClientValue!.get.mockResolvedValue(null);
    mockedWithLock.mockResolvedValue({ ran: false });

    const req = createMockRequest({ 'idempotency-key': 'key-5' });
    const res = createMockResponse();
    const next: NextFunction = jest.fn();

    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        message: expect.stringContaining('sedang diproses'),
      })
    );
  });

  it('item 2.13 — pesan 409 diterjemahkan sesuai locale response (en), default id tidak berubah', async () => {
    mockRedisClientValue!.get.mockResolvedValue(null);
    mockedWithLock.mockResolvedValue({ ran: false });

    const req = createMockRequest({ 'idempotency-key': 'key-6' });
    const res = createMockResponse();
    (res as unknown as { locals: Record<string, unknown> }).locals = { locale: 'en' };

    await middleware(req, res, jest.fn() as NextFunction);

    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message:
        'A request with the same Idempotency-Key is already being processed. Try again shortly.',
    });
  });
});
