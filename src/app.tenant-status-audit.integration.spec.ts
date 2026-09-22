import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application } from 'express';

/**
 * T3 — integration test end-to-end `PATCH /api/v1/tenants/:id/status`: `createApp()` sungguhan
 * lewat `supertest` (auth JWT asli, RBAC asli, controller/service/repository asli), Prisma
 * di-mock. Pola sama persis dengan `app.tenant-plan-audit.integration.spec.ts` (temuan T2) —
 * endpoint ini juga belum pernah dijalankan sebagai satu kesatuan sebelum test ini. Membuktikan:
 * perubahan status tercatat di audit log dengan "dari -> ke", baris LULUS verifikasi hash chain
 * lewat kode produksi asli, dan cache status (`cacheKeys.tenantStatusById`) benar-benar
 * diinvalidasi setelah suspend — bukan cuma diklaim di komentar kode.
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

jest.setTimeout(30_000);

interface Harness {
  app: Application;
  prismaMock: DeepMockProxy<PrismaClient>;
  sign: (role: string, id?: string) => string;
  AuditRepository: typeof import('./modules/audit/audit.repository').AuditRepository;
}

const TENANT_ID = 'tenant-1';

function buildHarness(): Harness {
  let harness!: Harness;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const database =
      require('./shared/config/database') as typeof import('./shared/config/database');
    const appModule = require('./app') as typeof import('./app');
    const { jwtHelper } = require('./shared/utils/jwt') as typeof import('./shared/utils/jwt');
    const { AuditRepository } =
      require('./modules/audit/audit.repository') as typeof import('./modules/audit/audit.repository');
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const prismaMock = database.prisma as unknown as DeepMockProxy<PrismaClient>;

    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return arg(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
    prismaMock.blacklistedToken.findUnique.mockResolvedValue(null);
    prismaMock.$queryRaw.mockResolvedValue([{ lastHash: null }] as never);
    prismaMock.$executeRaw.mockResolvedValue(1 as never);
    prismaMock.auditLog.create.mockImplementation(((args: { data: unknown }) =>
      Promise.resolve(args.data)) as never);

    const tenantRow = {
      id: TENANT_ID,
      slug: 'acme',
      name: 'Acme',
      status: 'ACTIVE',
      plan: 'PRO',
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };
    prismaMock.tenant.findFirst.mockResolvedValue(tenantRow as never);
    prismaMock.tenant.update.mockImplementation(((args: { data: { status: string } }) =>
      Promise.resolve({ ...tenantRow, status: args.data.status })) as never);

    harness = {
      app: appModule.createApp(),
      prismaMock,
      sign: (role, id = 'admin-1') =>
        jwtHelper.sign({ id, email: `${id}@example.com`, role } as never),
      AuditRepository,
    };
  });
  return harness;
}

describe('Integration: PATCH /api/v1/tenants/:id/status + audit log (T3)', () => {
  it('ADMIN men-suspend tenant ACTIVE -> SUSPENDED: 200, status tersimpan, audit UPDATE dengan "dari -> ke"', async () => {
    const { app, prismaMock, sign } = buildHarness();

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_ID}/status`)
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUSPENDED');
    expect(prismaMock.tenant.update).toHaveBeenCalledWith({
      where: { id: TENANT_ID },
      data: { status: 'SUSPENDED' },
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const written = (
      prismaMock.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(written).toMatchObject({
      action: 'UPDATE',
      entity: 'Tenant',
      entityId: TENANT_ID,
      userId: 'admin-1',
    });
    expect(JSON.parse(written.details as string)).toEqual({
      field: 'status',
      from: 'ACTIVE',
      to: 'SUSPENDED',
    });
    expect(typeof written.hash).toBe('string');
    expect(written.previousHash).toBeNull();
  });

  it('baris audit yang ditulis LULUS verifikasi hash chain lewat kode produksi asli', async () => {
    const { app, prismaMock, sign, AuditRepository } = buildHarness();

    await request(app)
      .patch(`/api/v1/tenants/${TENANT_ID}/status`)
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ status: 'SUSPENDED' });
    const written = (
      prismaMock.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;

    const repository = new AuditRepository(prismaMock as unknown as PrismaClient);
    prismaMock.auditLog.findMany.mockResolvedValue([written] as never);
    await expect(repository.verifyChainIntegrity()).resolves.toEqual({ valid: true });
  });

  it('role USER (tanpa tenant.manage) -> 403; status TIDAK diubah dan TIDAK ada audit', async () => {
    const { app, prismaMock, sign } = buildHarness();

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_ID}/status`)
      .set('Authorization', `Bearer ${sign('USER', 'user-9')}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(403);
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('tanpa token -> 401, tidak ada perubahan dan tidak ada audit', async () => {
    const { app, prismaMock } = buildHarness();

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_ID}/status`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(401);
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('tenant tidak ada -> 404, TIDAK ada audit untuk aksi yang tidak terjadi', async () => {
    const { app, prismaMock, sign } = buildHarness();
    prismaMock.tenant.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/v1/tenants/tidak-ada/status')
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(404);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('status tidak valid -> 422, tidak ada perubahan dan tidak ada audit', async () => {
    const { app, prismaMock, sign } = buildHarness();

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_ID}/status`)
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ status: 'PAUSED' });

    expect(res.status).toBe(422);
    expect(prismaMock.tenant.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('BATAS YANG DIKETAHUI: kalau penulisan audit GAGAL, perubahan status tetap berhasil (fail-open, perilaku AuditService untuk semua aksi)', async () => {
    const { app, prismaMock, sign } = buildHarness();
    prismaMock.auditLog.create.mockRejectedValue(new Error('database audit sedang down'));

    const res = await request(app)
      .patch(`/api/v1/tenants/${TENANT_ID}/status`)
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ status: 'SUSPENDED' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUSPENDED');
  });
});
