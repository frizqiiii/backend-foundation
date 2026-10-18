import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { WebhookRepository } from './webhook.repository';

/**
 * R18 — `WebhookRepository` di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: `webhook_endpoints` ber-FORCE RLS, tetapi repository memakai `this.prisma` biasa, yaitu koneksi yang
 * TIDAK membawa `app.tenant_id`. Di runtime: `POST /webhooks` gagal 500 (`42501`), `GET /webhooks` selalu kosong, dan
 * `findActiveByEventType` (jalur `WebhookService.trigger`) selalu kosong sehingga webhook tidak akan pernah terkirim.
 * Unit test dengan Prisma ter-mock tidak bisa menangkap ini; hanya database sungguhan yang bisa.
 *
 * Test ini meniru `tenantMiddleware`: membuka transaksi, `set_config('app.tenant_id', ...)`, lalu menjalankan
 * repository di dalam `runWithTenantContext` dengan `db: tx`. Dijalankan lewat `npm run test:rls`
 * (DB `backend_foundation_rls_test`; lihat `jest.setup.rls-e2e.ts`). Role database HARUS non-superuser.
 *
 * Yang dibuktikan:
 *  1. KONTROL — `prisma.webhookEndpoint.create` biasa (tanpa `app.tenant_id`) DITOLAK RLS. Ini mekanisme bug aslinya,
 *     dan memastikan test lain bermakna: kalau kontrol ini gagal, role kamu mem-bypass RLS.
 *  2. `create` lewat repository berhasil dan tersimpan dengan tenantId yang benar.
 *  3. `findManyForUser` / `findByIdForUser` hanya melihat endpoint milik tenant aktif.
 *  4. `findActiveByEventType` (R20) hanya mengembalikan endpoint tenant dari KONTEKS (transaksi mandiri, juga tanpa
 *     transaksi request), dan kosong (fail-closed) tanpa konteks tenant.
 *  5. `revoke` berhasil untuk tenant pemilik dan DITOLAK untuk tenant lain.
 */
describe('WebhookRepository di bawah FORCE RLS — database sungguhan (R18)', () => {
  const repository = new WebhookRepository(prisma);
  const marker = `rls-${randomUUID()}`;
  const eventType = `${marker}.created`;
  let tenantAId: string;
  let tenantBId: string;
  let ownerId: string;

  async function withBypass<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    });
  }

  // Meniru `tenantMiddleware`: transaksi + `app.tenant_id`, context membawa `tx`.
  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return runWithTenantContext({ tenantId, tenantSlug: 'rls-test', db: tx }, fn);
    });
  }

  function endpointData(tenantId: string, label: string) {
    return {
      userId: ownerId,
      tenantId,
      url: `https://example.com/${marker}/${label}`,
      encryptedSecret: `enc-${label}`,
      eventTypes: [eventType],
    };
  }

  async function rowOf(id: string) {
    return withBypass((tx) => tx.webhookEndpoint.findUnique({ where: { id } }));
  }

  beforeAll(async () => {
    const tenantA = await prisma.tenant.create({
      data: { slug: `webhooks-rls-a-${randomUUID()}`, name: 'Webhooks RLS A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `webhooks-rls-b-${randomUUID()}`, name: 'Webhooks RLS B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    const owner = await prisma.user.create({
      data: {
        email: `webhooks-rls-${randomUUID()}@example.com`,
        name: 'Webhooks RLS Owner',
        password: null,
      },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await withBypass((tx) =>
      tx.webhookEndpoint.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } })
    );
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('KONTROL: prisma.webhookEndpoint.create biasa (tanpa app.tenant_id) ditolak FORCE RLS', async () => {
    await expect(
      prisma.webhookEndpoint.create({
        data: {
          userId: ownerId,
          tenantId: tenantAId,
          url: `https://example.com/${marker}/kontrol`,
          secret: 'enc-kontrol',
          eventTypes: [eventType],
        },
      })
    ).rejects.toThrow(/row-level security/i);
  });

  it('create lewat repository (tenant aktif) berhasil dan tersimpan dengan tenantId yang benar', async () => {
    const created = await asTenant(tenantAId, () =>
      repository.create(endpointData(tenantAId, 'dibuat-a'))
    );

    expect(created.tenantId).toBe(tenantAId);
    expect((await rowOf(created.id))?.tenantId).toBe(tenantAId);
  });

  it('create dengan tenantId tenant LAIN ditolak RLS (WITH CHECK)', async () => {
    await expect(
      asTenant(tenantAId, () => repository.create(endpointData(tenantBId, 'salah-tenant')))
    ).rejects.toThrow();
  });

  it('findManyForUser dan findByIdForUser hanya melihat endpoint milik tenant aktif', async () => {
    const endpointA = await asTenant(tenantAId, () =>
      repository.create(endpointData(tenantAId, 'milik-a'))
    );
    const endpointB = await asTenant(tenantBId, () =>
      repository.create(endpointData(tenantBId, 'milik-b'))
    );

    // User pemilik SAMA untuk kedua tenant: pemisahnya murni RLS, bukan filter userId.
    const listA = await asTenant(tenantAId, () => repository.findManyForUser(ownerId));
    const listB = await asTenant(tenantBId, () => repository.findManyForUser(ownerId));

    expect(listA.map((e) => e.id)).toContain(endpointA.id);
    expect(listA.map((e) => e.id)).not.toContain(endpointB.id);
    expect(listB.map((e) => e.id)).toContain(endpointB.id);
    expect(listB.map((e) => e.id)).not.toContain(endpointA.id);

    expect(
      await asTenant(tenantAId, () => repository.findByIdForUser(endpointA.id, ownerId))
    ).toMatchObject({ id: endpointA.id });
    expect(
      await asTenant(tenantBId, () => repository.findByIdForUser(endpointA.id, ownerId))
    ).toBeNull();
  });

  it('findActiveByEventType (R20): hanya endpoint tenant aktif, lewat transaksi mandiri; tanpa tenant kosong', async () => {
    const endpointA = await asTenant(tenantAId, () =>
      repository.create(endpointData(tenantAId, 'aktif-a'))
    );
    const endpointB = await asTenant(tenantBId, () =>
      repository.create(endpointData(tenantBId, 'aktif-b'))
    );

    // Konteks tenant A TANPA transaksi request (meniru dispatch yang berjalan setelah transaksi request selesai).
    const asA = await runWithTenantContext(
      { tenantId: tenantAId, tenantSlug: 'rls-test', db: null },
      () => repository.findActiveByEventType(eventType)
    );
    expect(asA.map((e) => e.id)).toContain(endpointA.id);
    expect(asA.map((e) => e.id)).not.toContain(endpointB.id);

    const asB = await runWithTenantContext(
      { tenantId: tenantBId, tenantSlug: 'rls-test', db: null },
      () => repository.findActiveByEventType(eventType)
    );
    expect(asB.map((e) => e.id)).toContain(endpointB.id);
    expect(asB.map((e) => e.id)).not.toContain(endpointA.id);

    // Di dalam transaksi request tenant A: tetap hanya endpoint A.
    const inRequestA = await asTenant(tenantAId, () => repository.findActiveByEventType(eventType));
    expect(inRequestA.map((e) => e.id)).toContain(endpointA.id);
    expect(inRequestA.map((e) => e.id)).not.toContain(endpointB.id);

    // Tanpa konteks tenant sama sekali: fail-closed, bukan membaca semua tenant.
    expect(
      await runWithTenantContext({ tenantId: null, tenantSlug: null, db: null }, () =>
        repository.findActiveByEventType(eventType)
      )
    ).toEqual([]);
  });

  it('revoke: DITOLAK untuk tenant lain (baris tidak berubah), berhasil untuk pemilik', async () => {
    const endpoint = await asTenant(tenantAId, () =>
      repository.create(endpointData(tenantAId, 'untuk-revoke'))
    );

    await expect(asTenant(tenantBId, () => repository.revoke(endpoint.id))).rejects.toThrow();
    expect((await rowOf(endpoint.id))?.active).toBe(true);
    expect((await rowOf(endpoint.id))?.revokedAt).toBeNull();

    const revoked = await asTenant(tenantAId, () => repository.revoke(endpoint.id));
    expect(revoked.active).toBe(false);
    expect((await rowOf(endpoint.id))?.revokedAt).toBeInstanceOf(Date);

    // Setelah dicabut, tidak lagi muncul di jalur trigger.
    const active = await asTenant(tenantAId, () => repository.findActiveByEventType(eventType));
    expect(active.map((e) => e.id)).not.toContain(endpoint.id);
  });
});
