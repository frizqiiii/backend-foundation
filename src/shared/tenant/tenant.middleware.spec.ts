import type { Request, Response, NextFunction } from 'express';
import { getTenantContext } from './tenant-context';
import { ForbiddenError } from '../utils/http-error';

const resolveActiveTenantBySlugMock = jest.fn();

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
  })),
}));

jest.mock('../../modules/tenants/tenant.repository', () => ({
  TenantRepository: jest.fn(),
}));

import { tenantMiddleware } from './tenant.middleware';

function createMockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

/**
 * Fase 4 (RLS): `tenantMiddleware` menunggu event `'finish'`/`'close'`
 * di `res` sebelum transaksi (dan karenanya `tenantMiddleware` sendiri)
 * dianggap selesai — jadi `res` di sini butuh `.once(event, cb)` yang
 * BENAR-BENAR berfungsi (bukan objek kosong `{}` seperti Fase-Fase
 * sebelumnya), plus cara memicu event itu secara manual dari test
 * (mensimulasikan Express benar-benar mengirim response).
 */
function createMockRes(): Response & { emitFinish: () => void } {
  const finishListeners: Array<() => void> = [];
  return {
    once: jest.fn((event: string, cb: () => void) => {
      if (event === 'finish') finishListeners.push(cb);
    }),
    emitFinish: () => finishListeners.forEach((cb) => cb()),
  } as unknown as Response & { emitFinish: () => void };
}

describe('tenantMiddleware', () => {
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
    });

    const req = createMockReq({ 'x-tenant-id': 'acme' });
    const res = createMockRes();
    let observedContext: unknown;
    const next: NextFunction = jest.fn(() => {
      observedContext = getTenantContext();
      // `next()` di kode asli SELESAI DULU (sinkron), BARU baris
      // `res.once('finish', resolve)` sempat terdaftar — persis
      // seperti Express sungguhan (response baru benar-benar selesai
      // ASYNC, setelah middleware chain melepas call stack saat ini).
      // Kalau `emitFinish()` dipanggil sinkron di sini, listener-nya
      // belum sempat terdaftar sama sekali -> promise menggantung
      // selamanya -> test timeout.
      setImmediate(() => res.emitFinish());
    });

    await tenantMiddleware(req, res, next);

    expect(resolveActiveTenantBySlugMock).toHaveBeenCalledWith('acme');
    expect(observedContext).toEqual({
      tenantId: 'tenant-1',
      tenantSlug: 'acme',
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
});
