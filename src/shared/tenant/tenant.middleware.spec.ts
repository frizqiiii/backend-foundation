import type { Request, Response, NextFunction } from 'express';
import { getTenantContext } from './tenant-context';
import { ForbiddenError } from '../utils/http-error';

const resolveActiveTenantBySlugMock = jest.fn();

// PrismaClient sungguhan gagal di-construct tanpa `prisma generate`
// (butuh query engine binary) — di-mock supaya test ini tidak
// bergantung pada itu; `tenant.middleware.ts` hanya memakai `prisma`
// untuk membuat instance `TenantRepository` (juga di-mock di bawah),
// tidak pernah benar-benar memanggil method Prisma apa pun di sini.
jest.mock('../config/database', () => ({ prisma: {} }));

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

describe('tenantMiddleware', () => {
  it('melanjutkan request TANPA tenant context kalau tidak ada header X-Tenant-ID (backward compatible)', async () => {
    const req = createMockReq();
    const next = jest.fn() as NextFunction;

    await tenantMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith();
    expect(resolveActiveTenantBySlugMock).not.toHaveBeenCalled();
  });

  it('mengisi tenant context ketika header X-Tenant-ID valid & tenant aktif', async () => {
    resolveActiveTenantBySlugMock.mockResolvedValue({
      id: 'tenant-1',
      slug: 'acme',
      status: 'ACTIVE',
    });

    const req = createMockReq({ 'x-tenant-id': 'acme' });
    let observedContext: unknown;
    const next: NextFunction = jest.fn(() => {
      observedContext = getTenantContext();
    });

    await tenantMiddleware(req, {} as Response, next);

    expect(resolveActiveTenantBySlugMock).toHaveBeenCalledWith('acme');
    expect(observedContext).toEqual({ tenantId: 'tenant-1', tenantSlug: 'acme' });
  });

  it('meneruskan error ke next(error) kalau tenant tidak valid/tidak aktif', async () => {
    resolveActiveTenantBySlugMock.mockRejectedValue(new ForbiddenError('Tenant tidak aktif'));

    const req = createMockReq({ 'x-tenant-id': 'tidak-ada' });
    const next = jest.fn() as NextFunction;

    await tenantMiddleware(req, {} as Response, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });
});
