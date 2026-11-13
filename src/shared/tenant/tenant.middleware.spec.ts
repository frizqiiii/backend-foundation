import type { Request, Response, NextFunction } from 'express';
import { getTenantContext } from './tenant-context';
import { ForbiddenError } from '../utils/http-error';

const resolveActiveTenantBySlugMock = jest.fn();
const resolveActiveTenantByIdMock = jest.fn();
const findTenantIdByRawKeyMock = jest.fn();

/**
 * Fase 4 (RLS): `tenantMiddleware` sekarang membungkus SISA SIKLUS
 * request dalam `prisma.$transaction(async (tx) => {...}, opts)` (lihat
 * komentar panjang di `tenant.middleware.ts` — supaya `SET LOCAL
 * app.tenant_id` menempel sepanjang request). Mock `prisma` di sini
 * HARUS mensimulasikan itu — bukan cuma `{}` seperti sebelum Fase 4
 * (waktu itu `prisma` cuma dipakai bikin instance `TenantRepository`,
 * tidak pernah benar-benar dipanggil method-nya di file ini) — kalau
 * tidak, `prisma.$transaction` jadi `undefined`, `tenantMiddleware`
 * melempar TypeError yang KETANGKAP diam-diam oleh catch block-nya
 * sendiri lalu diteruskan ke `next(error)`, dan test jadi TIDAK
 * PERNAH benar-benar menguji perilaku yang dimaksud (tenant context
 * yang di-observe jadi context KOSONG, bukan context tenant asli).
 */
jest.mock('../config/database', () => ({
  prisma: {
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn({ $executeRaw: jest.fn(() => Promise.resolve()) })
    ),
  },
}));

// Mock TenantService SEBELUM `tenant.middleware.ts` di-import — modul
// itu membuat instance `TenantService` di top-level (module-level
// singleton, sama pola dengan `*.routes.ts` lain), jadi constructor
// & method-nya harus sudah di-mock lebih dulu.
jest.mock('../../modules/tenants/tenant.service', () => ({
  TenantService: jest.fn().mockImplementation(() => ({
    resolveActiveTenantBySlug: resolveActiveTenantBySlugMock,
    resolveActiveTenantById: resolveActiveTenantByIdMock,
  })),
}));

jest.mock('../../modules/api-keys/api-key.service', () => ({
  ApiKeyService: jest.fn().mockImplementation(() => ({
    findTenantIdByRawKey: findTenantIdByRawKeyMock,
  })),
}));

jest.mock('../../modules/api-keys/api-key.repository', () => ({
  ApiKeyRepository: jest.fn(),
}));

jest.mock('../../modules/tenants/tenant.repository', () => ({
  TenantRepository: jest.fn(),
}));

import { tenantMiddleware } from './tenant.middleware';
import { prisma } from '../config/database';

function createMockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

/**
 * `tenantMiddleware` menahan byte respons sampai transaksi ter-COMMIT: ia membungkus `res.end`, menunggu handler memanggilnya
 * (atau event `'close'`), COMMIT, baru memanggil `end` yang asli. Jadi `res` di sini butuh `end` yang bisa diamati
 * (`endMock` = `end` ASLI milik Express), `.once(event, cb)` yang BENAR-BENAR berfungsi, dan cara memicu "handler membalas"
 * (`emitFinish`, memanggil `res.end` TERKINI = pembungkus yang dipasang middleware) atau "koneksi putus" (`emitClose`).
 */
type MockRes = Response & {
  endMock: jest.Mock;
  emitFinish: (...args: unknown[]) => void;
  emitClose: () => void;
};

function createMockRes(headersSent = false): MockRes {
  const listeners: Record<string, Array<() => void>> = {};
  const endMock = jest.fn();
  const res = {
    headersSent,
    end: endMock,
    endMock,
    once: jest.fn((event: string, cb: () => void) => {
      (listeners[event] ??= []).push(cb);
    }),
    emitFinish: (...args: unknown[]) =>
      (res.end as unknown as (...a: unknown[]) => unknown)(...args),
    emitClose: () => (listeners.close ?? []).forEach((cb) => cb()),
  } as unknown as MockRes;
  return res;
}

describe('tenantMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('melanjutkan request TANPA tenant context kalau tidak ada header X-Tenant-ID (backward compatible)', async () => {
    const req = createMockReq();
    const next = jest.fn() as NextFunction;

    await tenantMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(resolveActiveTenantBySlugMock).not.toHaveBeenCalled();
  });

  it('mengisi tenant context (termasuk `db` = transaction client) ketika header X-Tenant-ID valid & tenant aktif', async () => {
    resolveActiveTenantBySlugMock.mockResolvedValue({
      id: 'tenant-1',
      slug: 'acme',
      status: 'ACTIVE',
      plan: 'ENTERPRISE',
    });

    const req = createMockReq({ 'x-tenant-id': 'acme' });
    const res = createMockRes();
    let observedContext: unknown;
    const next: NextFunction = jest.fn(() => {
      observedContext = getTenantContext();
      // `next()` di kode asli SELESAI DULU (sinkron), BARU pembungkus
      // `res.end` dan penantian `hold.ready` sempat terpasang — persis
      // seperti Express sungguhan (handler membalas ASYNC, setelah
      // middleware chain melepas call stack saat ini). Kalau
      // `emitFinish()` dipanggil sinkron di sini, tidak ada yang
      // menandai respons siap -> promise menggantung -> test timeout.
      setImmediate(() => res.emitFinish());
    });

    await tenantMiddleware(req, res, next);

    expect(resolveActiveTenantBySlugMock).toHaveBeenCalledWith('acme');
    expect(observedContext).toEqual({
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
      // Fase 2 item 2.11 — plan tenant ikut masuk context supaya
      // `tenantRateLimiter` bisa memilih kuota per-tier.
      tenantPlan: 'ENTERPRISE',
      db: { $executeRaw: expect.any(Function) },
    });
  });

  it('meneruskan error ke next(error) kalau tenant tidak valid/tidak aktif', async () => {
    resolveActiveTenantBySlugMock.mockRejectedValue(new ForbiddenError('Tenant tidak aktif'));

    const req = createMockReq({ 'x-tenant-id': 'tidak-ada' });
    const next = jest.fn() as NextFunction;

    await tenantMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });
  describe('R23 — tenant dari API key ketika header X-Tenant-ID tidak dikirim', () => {
    const acmeTenant = { id: 'tenant-acme', slug: 'acme', status: 'ACTIVE', plan: 'PRO' };

    /** Menjalankan middleware sampai selesai dan mengembalikan context yang terlihat oleh `next()`. */
    async function run(
      headers: Record<string, string>
    ): Promise<{ next: jest.Mock; context: unknown }> {
      const res = createMockRes();
      let context: unknown;
      const next = jest.fn(() => {
        context = getTenantContext();
        setImmediate(() => res.emitFinish());
      });
      await tenantMiddleware(createMockReq(headers), res, next as unknown as NextFunction);
      return { next, context };
    }

    it('memakai tenant milik API key yang valid (konteks tenant + transaksi RLS terisi)', async () => {
      findTenantIdByRawKeyMock.mockResolvedValue('tenant-acme');
      resolveActiveTenantByIdMock.mockResolvedValue(acmeTenant);

      const { context } = await run({ authorization: 'Bearer bfk_abc123' });

      expect(findTenantIdByRawKeyMock).toHaveBeenCalledWith('bfk_abc123');
      expect(resolveActiveTenantByIdMock).toHaveBeenCalledWith('tenant-acme');
      expect(resolveActiveTenantBySlugMock).not.toHaveBeenCalled();
      expect(context).toEqual({
        tenantId: 'tenant-acme',
        tenantSlug: 'acme',
        tenantPlan: 'PRO',
        db: { $executeRaw: expect.any(Function) },
      });
    });

    it('header X-Tenant-ID tetap menang: key tidak dilihat sama sekali', async () => {
      resolveActiveTenantBySlugMock.mockResolvedValue({
        ...acmeTenant,
        id: 'tenant-1',
        slug: 'default',
      });

      const { context } = await run({
        'x-tenant-id': 'default',
        authorization: 'Bearer bfk_abc123',
      });

      expect(findTenantIdByRawKeyMock).not.toHaveBeenCalled();
      expect(resolveActiveTenantByIdMock).not.toHaveBeenCalled();
      expect(context).toMatchObject({ tenantId: 'tenant-1', tenantSlug: 'default' });
    });

    it('tanpa konteks tenant untuk key yang tidak dikenal/dicabut/kedaluwarsa atau tanpa tenant', async () => {
      findTenantIdByRawKeyMock.mockResolvedValue(null);

      const { next, context } = await run({ authorization: 'Bearer bfk_abc123' });

      expect(next).toHaveBeenCalledWith();
      expect(resolveActiveTenantByIdMock).not.toHaveBeenCalled();
      expect(context).toEqual({ tenantId: null, tenantSlug: null, db: null });
    });

    it.each([
      ['token JWT (bukan API key)', 'Bearer eyJhbGciOi.payload.sig'],
      ['skema selain Bearer', 'Basic bfk_abc123'],
      ['header kosong', ''],
    ])('tidak mencari key sama sekali untuk %s', async (_label, authorization) => {
      const { context } = await run({ authorization });

      expect(findTenantIdByRawKeyMock).not.toHaveBeenCalled();
      expect(context).toEqual({ tenantId: null, tenantSlug: null, db: null });
    });

    it('menolak 403 (next(error), tanpa transaksi) kalau tenant milik key sedang tidak aktif', async () => {
      findTenantIdByRawKeyMock.mockResolvedValue('tenant-acme');
      resolveActiveTenantByIdMock.mockRejectedValue(
        new ForbiddenError('Tenant pemilik API key ini tidak ditemukan atau sedang tidak aktif')
      );
      const next = jest.fn() as NextFunction;

      await tenantMiddleware(
        createMockReq({ authorization: 'Bearer bfk_abc123' }),
        {} as Response,
        next
      );

      expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('respons ditahan sampai transaksi ter-COMMIT', () => {
    const tenant = { id: 'tenant-1', slug: 'acme', status: 'ACTIVE', plan: 'PRO' };
    const transactionMock = prisma.$transaction as unknown as jest.Mock;
    type TxFn = (tx: unknown) => Promise<unknown>;
    const fakeTx = () => ({ $executeRaw: jest.fn(() => Promise.resolve()) });

    /** `$transaction` palsu yang COMMIT-nya baru selesai setelah `release()` dipanggil (mensimulasikan commit lambat). */
    function slowCommit(events: string[]): { release: () => void } {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      transactionMock.mockImplementationOnce(async (fn: TxFn) => {
        const result = await fn(fakeTx());
        await gate;
        events.push('commit');
        return result;
      });
      return { release };
    }

    const reqAcme = () => createMockReq({ 'x-tenant-id': 'acme' });
    const nextThen = (action: () => void) =>
      jest.fn(() => {
        setImmediate(action);
      }) as unknown as NextFunction & jest.Mock;

    beforeEach(() => {
      resolveActiveTenantBySlugMock.mockResolvedValue(tenant);
    });

    it('TIDAK mengirim byte respons sebelum COMMIT selesai, lalu mengirim argumen asli SETELAH commit', async () => {
      const events: string[] = [];
      const commit = slowCommit(events);
      const res = createMockRes();
      res.endMock.mockImplementation(() => events.push('end'));
      const next = nextThen(() => res.emitFinish('badan', 'utf8'));

      const done = tenantMiddleware(reqAcme(), res, next);
      // Handler sudah memanggil res.end, tetapi COMMIT masih tertahan.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(res.endMock).not.toHaveBeenCalled();

      commit.release();
      await done;

      expect(events).toEqual(['commit', 'end']);
      expect(res.endMock).toHaveBeenCalledTimes(1);
      expect(res.endMock).toHaveBeenCalledWith('badan', 'utf8');
      // `end` asli dikembalikan setelah dilepas.
      expect(res.end).toBe(res.endMock);
    });

    it('kalau COMMIT gagal, respons yang ditahan DIBUANG dan error diteruskan ke next(error)', async () => {
      const commitError = new Error('commit gagal');
      transactionMock.mockImplementationOnce(async (fn: TxFn) => {
        await fn(fakeTx());
        throw commitError;
      });
      const res = createMockRes();
      const next = nextThen(() => res.emitFinish('201 palsu'));

      await tenantMiddleware(reqAcme(), res, next);

      expect(res.endMock).not.toHaveBeenCalled();
      expect(next).toHaveBeenLastCalledWith(commitError);
      // errorHandler memakai `res.end` asli untuk membalas error.
      expect(res.end).toBe(res.endMock);
    });

    it('respons yang headernya SUDAH terkirim (mis. streaming) tidak ditahan: `end` langsung diteruskan, sebelum commit', async () => {
      const events: string[] = [];
      const commit = slowCommit(events);
      const res = createMockRes(true);
      res.endMock.mockImplementation(() => events.push('end'));
      const next = nextThen(() => res.emitFinish('sisa'));

      const done = tenantMiddleware(reqAcme(), res, next);
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Byte sudah keluar dan tidak bisa ditarik, jadi `end` tidak boleh menunggu commit.
      expect(res.endMock).toHaveBeenCalledTimes(1);
      expect(res.endMock).toHaveBeenCalledWith('sisa');

      commit.release();
      await done;

      expect(events).toEqual(['end', 'commit']);
    });

    it('koneksi putus sebelum handler membalas: transaksi tetap selesai dan tidak ada `end` yang dikirim', async () => {
      const res = createMockRes();
      const next = nextThen(() => res.emitClose());

      await tenantMiddleware(reqAcme(), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.endMock).not.toHaveBeenCalled();
    });

    it('request tanpa tenant context tidak menyentuh `res.end` sama sekali', async () => {
      const res = createMockRes();
      const next = jest.fn() as NextFunction;
      const originalEnd = res.end;

      await tenantMiddleware(createMockReq(), res, next);

      expect(res.end).toBe(originalEnd);
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });
});
