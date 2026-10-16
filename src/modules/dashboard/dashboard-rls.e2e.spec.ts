import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { DashboardRepository } from './dashboard.repository';

/**
 * R21 — `DashboardRepository` di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: repository statistik memakai `this.prisma` tanpa `app.tenant_id` dan tanpa filter tenant. Akibatnya
 * untuk role non-superuser, angka events/products SELALU 0 (RLS fail-closed), sedangkan angka users/uploads/audit
 * global lintas tenant (bocor ke admin tenant mana pun). Test ini membuktikan perilaku baru:
 *  - mode TENANT: events/products lewat transaksi request (RLS) dan users difilter `tenantId`: hanya data tenant itu.
 *  - mode PLATFORM (tanpa tenant): events/products lewat transaksi `app.bypass_rls`: angka global yang sebenarnya.
 *  - `countUploads`/`countAuditLogsByAction` ditolak di mode tenant (tabelnya tanpa kolom tenant).
 *
 * Dijalankan lewat `npm run test:rls`. Role database HARUS non-superuser.
 */
describe('DashboardRepository di bawah FORCE RLS — database sungguhan (R21)', () => {
  const repository = new DashboardRepository(prisma);
  const marker = `rls-${randomUUID()}`;
  let tenantAId: string;
  let tenantBId: string;
  let ownerId: string;
  const userIds: string[] = [];

  async function withBypass<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return fn(tx);
    });
  }

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return runWithTenantContext({ tenantId, tenantSlug: 'rls-test', db: tx }, fn);
    });
  }

  const sum = (rows: Array<{ count: number }>): number => rows.reduce((a, r) => a + r.count, 0);

  beforeAll(async () => {
    const tenantA = await prisma.tenant.create({
      data: { slug: `dash-rls-a-${randomUUID()}`, name: 'Dash RLS A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `dash-rls-b-${randomUUID()}`, name: 'Dash RLS B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    for (const [label, tenantId] of [
      ['a1', tenantAId],
      ['a2', tenantAId],
      ['b1', tenantBId],
    ] as const) {
      const user = await prisma.user.create({
        data: {
          email: `${marker}-${label}@example.com`,
          name: `Dash ${label}`,
          password: null,
          tenantId,
        },
      });
      userIds.push(user.id);
    }
    ownerId = userIds[0];

    await withBypass(async (tx) => {
      // Tenant A: 2 events (Musik), 3 products. Tenant B: 1 event (Seni), 1 product.
      for (const [category, tenantId] of [
        ['Musik', tenantAId],
        ['Musik', tenantAId],
        ['Seni', tenantBId],
      ] as const) {
        await tx.event.create({
          data: {
            title: `${marker} event`,
            category,
            location: 'Jakarta',
            date: new Date('2030-01-01'),
            ownerId,
            tenantId,
          },
        });
      }
      for (const tenantId of [tenantAId, tenantAId, tenantAId, tenantBId]) {
        await tx.product.create({
          data: {
            title: `${marker} produk`,
            description: 'uji',
            price: 1000,
            stock: 1,
            userId: ownerId,
            tenantId,
          },
        });
      }
    });
  });

  afterAll(async () => {
    await withBypass(async (tx) => {
      await tx.event.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await tx.product.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('KONTROL: count biasa (tanpa app.tenant_id) melihat 0 events/products walau barisnya ada (bug lama)', async () => {
    expect(await prisma.event.count({ where: { tenantId: tenantAId } })).toBe(0);
    expect(await prisma.product.count({ where: { tenantId: tenantAId } })).toBe(0);
    const viaBypass = await withBypass((tx) => tx.event.count({ where: { tenantId: tenantAId } }));
    expect(viaBypass).toBe(2);
  });

  it('mode TENANT: events/products hanya milik tenant itu', async () => {
    expect(await asTenant(tenantAId, () => repository.countEvents())).toBe(2);
    expect(await asTenant(tenantBId, () => repository.countEvents())).toBe(1);
    expect(await asTenant(tenantAId, () => repository.countProducts())).toBe(3);
    expect(await asTenant(tenantBId, () => repository.countProducts())).toBe(1);
  });

  it('mode TENANT: breakdown (kategori event, status/kategori produk) hanya milik tenant itu', async () => {
    const eventsA = await asTenant(tenantAId, () => repository.countEventsByCategory());
    const eventsB = await asTenant(tenantBId, () => repository.countEventsByCategory());
    expect(eventsA).toEqual([{ category: 'Musik', count: 2 }]);
    expect(eventsB).toEqual([{ category: 'Seni', count: 1 }]);

    const statusA = await asTenant(tenantAId, () => repository.countProductsByStatus());
    const categoryB = await asTenant(tenantBId, () => repository.countProductsByCategory());
    expect(sum(statusA)).toBe(3);
    expect(sum(categoryB)).toBe(1);

    const timeline = await asTenant(tenantAId, () => repository.countEventsUpcomingVsPast());
    expect(timeline.upcoming + timeline.past).toBe(2);
  });

  it('mode TENANT: users dan pendaftaran 30 hari difilter tenantId (tabel users tidak ber-RLS)', async () => {
    expect(await asTenant(tenantAId, () => repository.countUsers())).toBe(2);
    expect(await asTenant(tenantBId, () => repository.countUsers())).toBe(1);

    const roleA = await asTenant(tenantAId, () => repository.countUsersByRole());
    expect(sum(roleA)).toBe(2);

    const signupsA = await asTenant(tenantAId, () => repository.signupsLast30Days());
    const signupsB = await asTenant(tenantBId, () => repository.signupsLast30Days());
    expect(sum(signupsA)).toBe(2);
    expect(sum(signupsB)).toBe(1);
  });

  it('mode PLATFORM (tanpa tenant): events/products global lewat bypass, mencakup kedua tenant', async () => {
    // Suite e2e lain berjalan PARALEL di database yang sama dan menambah/menghapus events/products miliknya, jadi
    // selisih terhadap baseline tidak deterministik. Baris uji ini tetap ada sampai afterAll, sehingga batas bawah
    // (tenant A + tenant B) pasti berlaku. Hitungan 0 (bug lama: RLS fail-closed) atau hanya satu tenant (2 atau 1
    // event; 3 atau 1 produk) tetap gagal di sini.
    expect(await repository.countEvents()).toBeGreaterThanOrEqual(3);
    expect(await repository.countProducts()).toBeGreaterThanOrEqual(4);
  });

  it('mode TENANT: countUploads dan countAuditLogsByAction ditolak (tanpa kolom tenant)', async () => {
    await expect(asTenant(tenantAId, () => repository.countUploads())).rejects.toThrow(
      /admin platform/i
    );
    await expect(asTenant(tenantAId, () => repository.countAuditLogsByAction())).rejects.toThrow(
      /admin platform/i
    );
  });
});
