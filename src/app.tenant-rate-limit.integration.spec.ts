import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { DeepMockProxy } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application } from 'express';
import { TENANT_HEADER_NAME } from './shared/tenant/tenant.constants';

/**
 * Fase 2 (item 2.11 — rate limit per-tier/plan) — integration test
 * end-to-end: `createApp()` sungguhan lewat `supertest`, Prisma
 * di-mock (pola sama dengan `app.integration.spec.ts`). Membuktikan
 * bahwa plan tenant benar-benar mengalir dari database ->
 * `tenantMiddleware` -> tenant context -> `tenantRateLimiter`, bukan
 * cuma benar di unit test masing-masing lapisan.
 *
 * Setiap test memakai `jest.isolateModules` supaya `tenantRateLimiter`
 * (singleton level modul di `app.ts`, MemoryStore) dan
 * `generalRateLimiter` per-IP mulai dari hitungan nol — tanpa itu
 * hitungan bocor antar test.
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

// Cold start ts-jest (compile `app.ts` + seluruh dependency-nya) + ratusan
// request sekuensial per test — default 5 detik terlalu mepet di mesin
// lambat/pertama kali dijalankan (terbukti gagal 1x di run pertama sandbox).
jest.setTimeout(30_000);

interface Harness {
  app: Application;
  prismaMock: DeepMockProxy<PrismaClient>;
}

function buildHarness(plan: 'FREE' | 'PRO' | 'ENTERPRISE' | undefined): Harness {
  let harness!: Harness;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const database =
      require('./shared/config/database') as typeof import('./shared/config/database');
    const appModule = require('./app') as typeof import('./app');
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const prismaMock = database.prisma as unknown as DeepMockProxy<PrismaClient>;

    prismaMock.$transaction.mockImplementation((arg: unknown) => {
      if (typeof arg === 'function') {
        return arg(prismaMock);
      }
      return Promise.all(arg as Promise<unknown>[]);
    });
    prismaMock.tenant.findFirst.mockResolvedValue({
      id: 'tenant-plan-test',
      slug: 'plan-test',
      name: 'Plan Test',
      status: 'ACTIVE',
      // `undefined` mensimulasikan baris/cache lama tanpa field plan.
      ...(plan ? { plan } : {}),
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as never);

    harness = { app: appModule.createApp(), prismaMock };
  });
  return harness;
}

/** Path yang tidak ada di bawah /api/v1 — 404 biasa, TAPI tetap melewati limiter per-IP & per-tenant. */
async function hit(app: Application): Promise<request.Response> {
  return request(app).get('/api/v1/tidak-ada-endpoint-ini').set(TENANT_HEADER_NAME, 'plan-test');
}

async function statusesAfter(app: Application, total: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < total; i += 1) {
    // Sekuensial (bukan Promise.all) supaya urutan penghitungan deterministik.
    // eslint-disable-next-line no-await-in-loop
    statuses.push((await hit(app)).status);
  }
  return statuses;
}

describe('Integration: rate limit per-tenant mengikuti plan (item 2.11)', () => {
  it('FREE: 200 request lolos (404 biasa), request ke-201 ditolak 429 oleh limiter TENANT (bukan per-IP)', async () => {
    const { app } = buildHarness('FREE');

    const statuses = await statusesAfter(app, 200);
    expect(statuses).not.toContain(429);

    const res = await hit(app);
    expect(res.status).toBe(429);
    expect(res.body.message).toMatch(/Tenant ini telah melebihi kuota/);
  });

  it('ENTERPRISE: request ke-201 (yang ditolak untuk FREE) MASIH lolos — kuota tenant benar-benar lebih besar', async () => {
    const { app } = buildHarness('ENTERPRISE');

    const statuses = await statusesAfter(app, 201);

    expect(statuses).not.toContain(429);
  });

  it('BACKWARD COMPATIBLE — tenant tanpa field plan (cache/baris lama) diperlakukan sebagai tier default (PRO), bukan diblokir', async () => {
    const { app } = buildHarness(undefined);

    const statuses = await statusesAfter(app, 201);

    expect(statuses).not.toContain(429);
  });

  it('header RateLimit-Limit pada response mencerminkan kuota tier tenant (klien bisa tahu batasnya)', async () => {
    const free = buildHarness('FREE');
    const enterprise = buildHarness('ENTERPRISE');

    const freeRes = await hit(free.app);
    const enterpriseRes = await hit(enterprise.app);

    // Ada DUA header ratelimit-limit (per-IP lalu per-tenant) — yang
    // terakhir menimpa; yang dijadikan patokan adalah limiter tenant.
    expect(freeRes.headers['ratelimit-limit']).toBe('200');
    expect(enterpriseRes.headers['ratelimit-limit']).toBe('5000');
  });
});
