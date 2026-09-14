import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * RLS Bypass Test (Fase 4) — SENGAJA BERBEDA dari hampir semua test
 * lain di project ini: tidak ada `jest.mock('../config/database', ...)`
 * sama sekali di sini. Prisma yang dipakai adalah client SUNGGUHAN,
 * connect ke Postgres SUNGGUHAN (`DATABASE_URL`, sama seperti yang
 * dipakai `test:e2e`/CI — lihat `.github/workflows/ci.yml`).
 *
 * INI SENGAJA, BUKAN KELALAIAN: RLS adalah fitur yang ditegakkan
 * DATABASE, bukan kode aplikasi. Mem-verifikasinya lewat Prisma yang
 * di-mock hanya membuktikan "kode kita memanggil Prisma dengan
 * parameter yang benar" — sama sekali tidak membuktikan bahwa
 * Postgres betulan menolak query lintas-tenant kalau suatu saat kode
 * aplikasi (Repository/Service) lupa/salah menambahkan filter
 * `tenantId`. Roadmap Fase 4 secara eksplisit meminta test SEPERTI
 * INI: "mencoba bypass tenant scoping secara sengaja dari level SQL
 * langsung (bukan cuma dari kode aplikasi), pastikan tetap ditolak
 * database".
 *
 * Skenario: dua tenant dibuat, tenant B punya satu produk "rahasia".
 * Test ini SENGAJA memanggil `$queryRaw`/`$executeRaw` MENTAH,
 * mem-bypass SELURUH Repository/Service layer — meniru seakurat
 * mungkin "developer lupa menambahkan where.tenantId di satu endpoint
 * baru". Satu-satunya pembeda konteks tenant di sini HANYALAH
 * `set_config('app.tenant_id', ...)`, PERSIS seperti yang dilakukan
 * `tenantMiddleware` untuk request sungguhan.
 *
 * PRASYARAT MENJALANKAN FILE INI: `DATABASE_URL` mengarah ke Postgres
 * sungguhan (lokal via `docker compose up -d`, atau CI service
 * container) DAN migration `20260913120000_enable_rls_multi_tenancy`
 * SUDAH di-apply (`npx prisma migrate dev` / `npx prisma migrate
 * deploy`). Tanpa migration itu, test ini akan GAGAL DENGAN ALASAN
 * SALAH (tabel belum ber-RLS sama sekali, semua assertion "harus
 * ditolak" akan gagal) — bukan bukti RLS tidak bekerja.
 */
describe('RLS: isolasi tenant ditegakkan di level database (bukan cuma kode aplikasi)', () => {
  let tenantAId: string;
  let tenantBId: string;
  let ownerBId: string;
  let productOfTenantBId: string;

  beforeAll(async () => {
    // Setup data — dibuat lewat Prisma biasa, DI LUAR konteks tenant
    // manapun (belum ada set_config apa pun), jadi masih BEBAS dari
    // policy yang sedang diuji. Tenant sendiri tidak punya kolom
    // tenant_id (dia AKAR-nya), jadi tidak tersentuh RLS iterasi ini.
    const tenantA = await prisma.tenant.create({
      data: { slug: `rls-test-a-${randomUUID()}`, name: 'RLS Test Tenant A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `rls-test-b-${randomUUID()}`, name: 'RLS Test Tenant B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const ownerB = await prisma.user.create({
      data: {
        email: `rls-owner-b-${randomUUID()}@example.com`,
        name: 'RLS Owner B',
        password: null,
      },
    });
    ownerBId = ownerB.id;

    // Produk tenant B dibuat lewat `withRlsBypass`-style manual (SET
    // app.bypass_rls) — bukan lewat Repository/Service — supaya SETUP
    // data ini sendiri tidak diam-diam bergantung pada policy yang
    // justru sedang mau kita buktikan.
    const product = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return tx.product.create({
        data: {
          title: 'Produk Rahasia Tenant B',
          description: 'Tidak boleh terlihat/tersentuh tenant lain',
          price: 100000,
          stock: 1,
          userId: ownerBId,
          tenantId: tenantBId,
        },
      });
    });
    productOfTenantBId = product.id;
  });

  afterAll(async () => {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.product.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
    });
    await prisma.user.delete({ where: { id: ownerBId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('SELECT mentah dari tenant A tidak bisa melihat produk milik tenant B', async () => {
    const rows = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
      return tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM products WHERE id = ${productOfTenantBId}`;
    });

    expect(rows).toHaveLength(0);
  });

  it('UPDATE mentah dari tenant A tidak bisa mengubah produk milik tenant B (WITH CHECK menolak)', async () => {
    const affectedRows = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantAId}, true)`;
      return tx.$executeRaw`UPDATE products SET title = 'DIRETAS TENANT A' WHERE id = ${productOfTenantBId}`;
    });

    expect(affectedRows).toBe(0);

    // Verifikasi baris ASLI benar-benar tidak berubah (bukan cuma
    // percaya angka "0 baris ter-update" tanpa mengecek ulang).
    const untouched = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return tx.product.findUniqueOrThrow({ where: { id: productOfTenantBId } });
    });
    expect(untouched.title).toBe('Produk Rahasia Tenant B');
  });

  it('tanpa app.tenant_id di-set sama sekali, query juga TIDAK mengembalikan apa pun (fail-closed)', async () => {
    const rows = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // SENGAJA tidak memanggil set_config apa pun di sini —
      // mensimulasikan bug "lupa lewat tenantMiddleware sama sekali".
      return tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM products WHERE id = ${productOfTenantBId}`;
    });

    expect(rows).toHaveLength(0);
  });

  it('tenant B sendiri TETAP bisa membaca produknya sendiri (RLS tidak overblocking)', async () => {
    const rows = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantBId}, true)`;
      return tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM products WHERE id = ${productOfTenantBId}`;
    });

    expect(rows).toHaveLength(1);
  });
});
