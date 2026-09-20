import request from 'supertest';
import { mockDeep } from 'jest-mock-extended';
import type { PrismaClient } from '@prisma/client';
import type { Application, RequestHandler } from 'express';

/**
 * Fase 2 (temuan T8) — perilaku NYATA `createApiRouter()`: router versi baru yang dibuat lewat fungsi
 * ini terlindungi rate limit sejak dibuat, kuotanya digabung lintas versi, dan router `Router()` polos
 * TIDAK terlindungi (kontrol negatif — alasan penjaga `api-router.guard.spec.ts` ada).
 *
 * `jest.isolateModules` per test supaya limiter singleton (MemoryStore) mulai dari nol.
 */
jest.mock('./shared/config/database', () => {
  const prismaMockInstance = mockDeep<PrismaClient>();
  return { prisma: prismaMockInstance, prismaRead: prismaMockInstance };
});

jest.setTimeout(60_000);

interface Harness {
  app: Application;
}

function buildHarness(options: {
  versions: string[];
  plainVersions?: string[];
  tenantPlan?: 'FREE' | 'PRO' | 'ENTERPRISE';
}): Harness {
  let harness!: Harness;
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */
    const express = require('express') as typeof import('express');
    const appModule = require('./app') as typeof import('./app');
    const tenantContext =
      require('./shared/tenant/tenant-context') as typeof import('./shared/tenant/tenant-context');
    /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports */

    const app = express();
    if (options.tenantPlan) {
      const plan = options.tenantPlan;
      const withTenant: RequestHandler = (_req, _res, next) => {
        tenantContext.runWithTenantContext(
          { tenantId: 't-1', tenantSlug: 't-1', tenantPlan: plan, db: null as never },
          next
        );
      };
      app.use(withTenant);
    }
    for (const version of options.versions) {
      const router = appModule.createApiRouter();
      router.get('/ping', (_req, res) => {
        res.json({ ok: true });
      });
      app.use(`/api/${version}`, router);
    }
    for (const version of options.plainVersions ?? []) {
      const router = express.Router(); // SENGAJA polos — kontrol negatif
      router.get('/ping', (_req, res) => {
        res.json({ ok: true });
      });
      app.use(`/api/${version}`, router);
    }
    harness = { app };
  });
  return harness;
}

async function hit(app: Application, version: string): Promise<request.Response> {
  return request(app).get(`/api/${version}/ping`);
}

describe('Integration: createApiRouter() untuk router API berversi (temuan T8)', () => {
  it('router versi baru (/api/v2) terlindungi limiter per-IP: 300 lolos, ke-301 ditolak "dari IP ini"', async () => {
    const { app } = buildHarness({ versions: ['v2'] });

    for (let i = 0; i < 300; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await hit(app, 'v2')).status).toBe(200);
    }
    const blocked = await hit(app, 'v2');
    expect(blocked.status).toBe(429);
    expect(blocked.body.message ?? blocked.text).toMatch(/dari IP ini/);
  });

  it('kuota per-IP DIGABUNG lintas versi: 150 di /api/v1 + 150 di /api/v2 menghabiskan jatah, ke-301 (di versi mana pun) ditolak', async () => {
    const { app } = buildHarness({ versions: ['v1', 'v2'] });

    for (let i = 0; i < 150; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await hit(app, 'v1')).status).toBe(200);
    }
    for (let i = 0; i < 150; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await hit(app, 'v2')).status).toBe(200);
    }
    expect((await hit(app, 'v1')).status).toBe(429);
    expect((await hit(app, 'v2')).status).toBe(429);
  });

  it('limiter per-TENANT juga terpasang di versi baru: tenant FREE (200/15 menit) ditolak di request ke-201', async () => {
    const { app } = buildHarness({ versions: ['v2'], tenantPlan: 'FREE' });

    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await hit(app, 'v2')).status).toBe(200);
    }
    const blocked = await hit(app, 'v2');
    expect(blocked.status).toBe(429);
    expect(blocked.body.message ?? blocked.text).toMatch(/Tenant ini telah melebihi kuota/);
  });

  it('KONTROL NEGATIF: router dari Router() polos TIDAK terlindungi — 320 request semuanya lolos (inilah celah yang dijaga api-router.guard.spec.ts)', async () => {
    const { app } = buildHarness({ versions: [], plainVersions: ['v2'] });

    for (let i = 0; i < 320; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await hit(app, 'v2')).status).toBe(200);
    }
  });
});
