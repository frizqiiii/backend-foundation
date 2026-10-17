import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { ProductRepository } from './product.repository';
import type { ListProductsQueryDto } from './product.dto';

/**
 * R15 — `ProductRepository.findMany` di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: `products` ber-FORCE RLS. `findMany` membaca lewat `prismaRead`, koneksi yang TIDAK membawa
 * `app.tenant_id` (dan tidak bisa ikut transaksi request, karena replica adalah koneksi terpisah). Akibatnya untuk role
 * non-superuser `GET /products` SELALU kosong walau barisnya ada. `create`/`findById`/`delete` sudah memakai
 * `getScopedPrisma`, hanya `findMany` yang ketinggalan. Unit test dengan Prisma ter-mock tidak bisa menangkap ini.
 *
 * Test ini meniru `tenantMiddleware`: transaksi + `app.tenant_id`, repository dijalankan di dalam
 * `runWithTenantContext` dengan `db: tx`. Dijalankan lewat `npm run test:rls`. Role database HARUS non-superuser.
 *
 * Yang dibuktikan:
 *  1. KONTROL — `prisma.product.findMany` biasa (tanpa `app.tenant_id`) TIDAK melihat baris yang sebenarnya ada
 *     (mekanisme bug aslinya); memastikan test lain bermakna.
 *  2. `findMany` (tenant aktif) melihat produk tenant itu, dan TIDAK melihat produk tenant lain.
 *  3. `total` konsisten dengan `data`, dan paginasi bekerja di bawah RLS.
 *  4. `findById` tetap hanya melihat produk tenant aktif.
 */
describe('ProductRepository.findMany di bawah FORCE RLS — database sungguhan (R15)', () => {
  // `prismaRead` sengaja DIBEDAKAN dari primary bukan dengan koneksi lain, tapi dengan klien yang sama: yang diuji
  // adalah bahwa jalur tenant TIDAK bergantung pada `prismaRead`. Dengan satu DB, `prismaRead = prisma` seperti di dev.
  const repository = new ProductRepository(prisma, prisma);
  const marker = `rls-${randomUUID()}`;
  let tenantAId: string;
  let tenantBId: string;
  let ownerId: string;

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

  function productData(label: string) {
    return {
      title: `${marker} ${label}`,
      description: 'produk uji RLS',
      price: 1000,
      stock: 5,
      userId: ownerId,
    };
  }

  const listQuery = (extra: Partial<ListProductsQueryDto> = {}) =>
    ({ page: 1, limit: 50, ...extra }) as ListProductsQueryDto;

  const mine = <T extends { title: string }>(rows: T[]): T[] =>
    rows.filter((r) => r.title.startsWith(marker));

  beforeAll(async () => {
    const tenantA = await prisma.tenant.create({
      data: { slug: `products-rls-a-${randomUUID()}`, name: 'Products RLS A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `products-rls-b-${randomUUID()}`, name: 'Products RLS B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    const owner = await prisma.user.create({
      data: {
        email: `products-rls-${randomUUID()}@example.com`,
        name: 'Products RLS Owner',
        password: null,
      },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await withBypass((tx) =>
      tx.product.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } })
    );
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('KONTROL: findMany biasa (tanpa app.tenant_id) TIDAK melihat baris yang ada (mekanisme bug aslinya)', async () => {
    const created = await asTenant(tenantAId, () => repository.create(productData('kontrol')));

    const viaPlainClient = await prisma.product.findMany({ where: { tenantId: tenantAId } });
    const viaBypass = await withBypass((tx) => tx.product.findMany({ where: { id: created.id } }));

    expect(viaPlainClient).toEqual([]);
    expect(viaBypass).toHaveLength(1);
  });

  it('findMany (tenant aktif) melihat produk tenant itu dan TIDAK melihat produk tenant lain', async () => {
    const productA = await asTenant(tenantAId, () => repository.create(productData('milik-a')));
    const productB = await asTenant(tenantBId, () => repository.create(productData('milik-b')));

    const listA = await asTenant(tenantAId, () => repository.findMany(listQuery()));
    const listB = await asTenant(tenantBId, () => repository.findMany(listQuery()));

    expect(mine(listA.data).map((p) => p.id)).toContain(productA.id);
    expect(mine(listA.data).map((p) => p.id)).not.toContain(productB.id);
    expect(mine(listB.data).map((p) => p.id)).toEqual([productB.id]);
  });

  it('total konsisten dengan data dan paginasi bekerja di bawah RLS', async () => {
    const ids: string[] = [];
    for (const label of ['p1', 'p2', 'p3']) {
      const p = await asTenant(tenantAId, () => repository.create(productData(`page-${label}`)));
      ids.push(p.id);
    }

    const page1 = await asTenant(tenantAId, () => repository.findMany(listQuery({ limit: 2 })));
    const page2 = await asTenant(tenantAId, () =>
      repository.findMany(listQuery({ limit: 2, page: 2 }))
    );

    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBeGreaterThanOrEqual(3);
    expect(page2.total).toBe(page1.total);
    const seen = [...page1.data, ...page2.data].map((p) => p.id);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('findById hanya melihat produk milik tenant aktif', async () => {
    const productA = await asTenant(tenantAId, () => repository.create(productData('by-id')));

    expect(await asTenant(tenantAId, () => repository.findById(productA.id))).toMatchObject({
      id: productA.id,
    });
    expect(await asTenant(tenantBId, () => repository.findById(productA.id))).toBeNull();
  });
});
