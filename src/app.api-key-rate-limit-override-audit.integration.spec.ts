import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application } from 'express';

/**
 * T4 — integration test end-to-end `PATCH /api/v1/api-keys/:id/rate-limit-override`:
 * `createApp()` sungguhan lewat `supertest` (auth JWT asli, RBAC asli, controller/service/
 * repository asli), Prisma di-mock. Pola sama persis dengan
 * `app.tenant-status-audit.integration.spec.ts` (T3) dan `app.tenant-plan-audit.integration.spec.ts`
 * (T2) — endpoint ini juga belum pernah dijalankan sebagai satu kesatuan sebelum test ini.
 * Membuktikan: hanya role dengan `api-key.manage` yang bisa mengubah override MILIK USER
 * MANA PUN (bukan cuma key sendiri), dan perubahan tercatat di audit log dengan "dari -> ke".
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
}

const KEY_ID = 'key-1';
const KEY_OWNER_ID = 'someone-else';

function buildHarness(): Harness {
  let harness!: Harness;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const database =
      require('./shared/config/database') as typeof import('./shared/config/database');
    const appModule = require('./app') as typeof import('./app');
    const { jwtHelper } = require('./shared/utils/jwt') as typeof import('./shared/utils/jwt');
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

    const keyRow = {
      id: KEY_ID,
      userId: KEY_OWNER_ID, // BUKAN pemilik yang login sebagai ADMIN di bawah -- inti dari T4.
      tenantId: null,
      name: "Partner's CI key",
      keyPrefix: 'bfk_partner',
      keyHash: 'irrelevant',
      scopes: ['event.read'],
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      rateLimitOverridePerMinute: null,
      createdAt: new Date(),
    };
    prismaMock.apiKey.findUnique.mockResolvedValue(keyRow as never);
    prismaMock.apiKey.update.mockImplementation(((args: {
      data: { rateLimitOverridePerMinute: number | null };
    }) =>
      Promise.resolve({
        ...keyRow,
        rateLimitOverridePerMinute: args.data.rateLimitOverridePerMinute,
      })) as never);

    harness = {
      app: appModule.createApp(),
      prismaMock,
      sign: (role, id = 'admin-1') =>
        jwtHelper.sign({ id, email: `${id}@example.com`, role } as never),
    };
  });
  return harness;
}

describe('Integration: PATCH /api/v1/api-keys/:id/rate-limit-override + audit log (T4)', () => {
  it('ADMIN memberi override pada API KEY MILIK USER LAIN (bukan self-service): 200, tersimpan, audit UPDATE "dari -> ke"', async () => {
    const { app, prismaMock, sign } = buildHarness();

    const res = await request(app)
      .patch(`/api/v1/api-keys/${KEY_ID}/rate-limit-override`)
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ rateLimitOverridePerMinute: 5000 });

    expect(res.status).toBe(200);
    expect(res.body.data.rateLimitOverridePerMinute).toBe(5000);
    expect(prismaMock.apiKey.update).toHaveBeenCalledWith({
      where: { id: KEY_ID },
      data: { rateLimitOverridePerMinute: 5000 },
    });

    expect(prismaMock.auditLog.create).toHaveBeenCalledTimes(1);
    const written = (
      prismaMock.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(written).toMatchObject({
      action: 'UPDATE',
      entity: 'ApiKey',
      entityId: KEY_ID,
      userId: 'admin-1',
    });
    expect(JSON.parse(written.details as string)).toEqual({
      field: 'rateLimitOverridePerMinute',
      from: null,
      to: 5000,
    });
  });

  it('null menghapus override lewat endpoint yang sama: audit mencatat "dari 5000 ke null"', async () => {
    const { app, prismaMock, sign } = buildHarness();
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: KEY_ID,
      userId: KEY_OWNER_ID,
      tenantId: null,
      name: "Partner's CI key",
      keyPrefix: 'bfk_partner',
      keyHash: 'irrelevant',
      scopes: ['event.read'],
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      rateLimitOverridePerMinute: 5000,
      createdAt: new Date(),
    } as never);

    const res = await request(app)
      .patch(`/api/v1/api-keys/${KEY_ID}/rate-limit-override`)
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ rateLimitOverridePerMinute: null });

    expect(res.status).toBe(200);
    expect(res.body.data.rateLimitOverridePerMinute).toBeNull();
    const written = (
      prismaMock.auditLog.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(JSON.parse(written.details as string)).toEqual({
      field: 'rateLimitOverridePerMinute',
      from: 5000,
      to: null,
    });
  });

  it('role USER (tanpa api-key.manage) -> 403; TIDAK diubah dan TIDAK ada audit — walau ini API KEY MILIK SENDIRI', async () => {
    const { app, prismaMock, sign } = buildHarness();
    prismaMock.apiKey.findUnique.mockResolvedValue({
      id: KEY_ID,
      userId: 'user-9', // sama dengan id yang sign() di bawah -- membuktikan "punya sendiri" pun TETAP butuh api-key.manage.
      tenantId: null,
      name: 'My own key',
      keyPrefix: 'bfk_own',
      keyHash: 'irrelevant',
      scopes: [],
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      rateLimitOverridePerMinute: null,
      createdAt: new Date(),
    } as never);

    const res = await request(app)
      .patch(`/api/v1/api-keys/${KEY_ID}/rate-limit-override`)
      .set('Authorization', `Bearer ${sign('USER', 'user-9')}`)
      .send({ rateLimitOverridePerMinute: 999999 });

    expect(res.status).toBe(403);
    expect(prismaMock.apiKey.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('tanpa token -> 401, tidak ada perubahan dan tidak ada audit', async () => {
    const { app, prismaMock } = buildHarness();

    const res = await request(app)
      .patch(`/api/v1/api-keys/${KEY_ID}/rate-limit-override`)
      .send({ rateLimitOverridePerMinute: 5000 });

    expect(res.status).toBe(401);
    expect(prismaMock.apiKey.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('API key tidak ada -> 404, TIDAK ada audit untuk aksi yang tidak terjadi', async () => {
    const { app, prismaMock, sign } = buildHarness();
    prismaMock.apiKey.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/v1/api-keys/tidak-ada/rate-limit-override')
      .set('Authorization', `Bearer ${sign('ADMIN')}`)
      .send({ rateLimitOverridePerMinute: 5000 });

    expect(res.status).toBe(404);
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  it('nilai 0/negatif/desimal -> 422, tidak ada perubahan dan tidak ada audit', async () => {
    const { app, prismaMock, sign } = buildHarness();

    for (const bad of [0, -5, 12.5]) {
      const res = await request(app)
        .patch(`/api/v1/api-keys/${KEY_ID}/rate-limit-override`)
        .set('Authorization', `Bearer ${sign('ADMIN')}`)
        .send({ rateLimitOverridePerMinute: bad });

      expect(res.status).toBe(422);
    }
    expect(prismaMock.apiKey.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });
});
