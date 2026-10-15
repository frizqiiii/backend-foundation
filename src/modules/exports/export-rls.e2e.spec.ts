import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { ExportRepository } from './export.repository';

/**
 * R19 — `ExportRepository` di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: `export_jobs` ber-FORCE RLS. Dua masalah di runtime sebelum perbaikan ini:
 *  1. API: repository memakai `this.prisma` biasa (koneksi tanpa `app.tenant_id`), sehingga `POST /exports` gagal 500
 *     (`42501`) dan `GET /exports/:id` selalu 404.
 *  2. Worker BullMQ: tidak lewat `tenantMiddleware`, jadi tidak punya konteks tenant sama sekali. `markProcessing/
 *     Completed/Failed` tidak menemukan baris (update 0 baris -> P2025) dan job macet.
 * Ada juga balapan: `tenantMiddleware` baru meng-commit transaksi request SETELAH response selesai, padahal job di-enqueue
 * di tengah request dan worker (proses lain) bisa mengambilnya dalam milidetik. Karena itu `create` memakai transaksi
 * MANDIRI yang sudah ter-commit saat `create` kembali.
 *
 * Dijalankan lewat `npm run test:rls` (DB `backend_foundation_rls_test`; lihat `jest.setup.rls-e2e.ts`). Role database
 * HARUS non-superuser. Yang dibuktikan:
 *  1. KONTROL — `prisma.exportJob.create` biasa (tanpa `app.tenant_id`) DITOLAK RLS (memastikan test lain bermakna).
 *  2. `create` (tenant aktif) berhasil dan tersimpan dengan tenantId yang benar.
 *  3. `create` di dalam transaksi request yang MASIH TERBUKA sudah terlihat oleh koneksi lain (ter-commit) — inilah
 *     prasyarat agar worker dapat menemukan baris itu.
 *  4. `findByIdForUser` hanya melihat job milik tenant aktif.
 *  5. Jalur worker (TANPA konteks): `mark*` dengan tenantId dari data job berhasil, ter-commit per langkah.
 *  6. Jalur worker dengan tenantId SALAH atau null DITOLAK (baris tidak berubah): fail-closed.
 */
describe('ExportRepository di bawah FORCE RLS — database sungguhan (R19)', () => {
  const repository = new ExportRepository(prisma);
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

  function createInput(tenantId: string) {
    return { userId: ownerId, tenantId, type: 'USERS' as const, format: 'CSV' as const };
  }

  async function rowOf(id: string) {
    return withBypass((tx) => tx.exportJob.findUnique({ where: { id } }));
  }

  beforeAll(async () => {
    const tenantA = await prisma.tenant.create({
      data: { slug: `exports-rls-a-${randomUUID()}`, name: 'Exports RLS A' },
    });
    const tenantB = await prisma.tenant.create({
      data: { slug: `exports-rls-b-${randomUUID()}`, name: 'Exports RLS B' },
    });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;
    const owner = await prisma.user.create({
      data: {
        email: `exports-rls-${randomUUID()}@example.com`,
        name: 'Exports RLS Owner',
        password: null,
      },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await withBypass((tx) =>
      tx.exportJob.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } })
    );
    await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
  });

  it('KONTROL: prisma.exportJob.create biasa (tanpa app.tenant_id) ditolak FORCE RLS', async () => {
    await expect(
      prisma.exportJob.create({
        data: {
          userId: ownerId,
          tenantId: tenantAId,
          type: 'USERS',
          format: 'CSV',
          status: 'QUEUED',
        },
      })
    ).rejects.toThrow(/row-level security/i);
  });

  it('create (tenant aktif) berhasil dan tersimpan dengan tenantId yang benar, status QUEUED', async () => {
    const created = await asTenant(tenantAId, () => repository.create(createInput(tenantAId)));

    expect(created.tenantId).toBe(tenantAId);
    expect(created.status).toBe('QUEUED');
    expect((await rowOf(created.id))?.tenantId).toBe(tenantAId);
  });

  it('create di dalam transaksi request yang MASIH TERBUKA sudah ter-commit: terlihat oleh koneksi lain (syarat worker)', async () => {
    let visibleWhileRequestTxOpen: unknown = 'belum-dicek';

    await asTenant(tenantAId, async () => {
      const created = await repository.create(createInput(tenantAId));
      // Transaksi request (`asTenant`) belum selesai di titik ini. Koneksi lain (bypass) harus SUDAH melihat barisnya,
      // persis seperti worker yang mengambil job dari antrian sebelum response request selesai.
      visibleWhileRequestTxOpen = await rowOf(created.id);
    });

    expect(visibleWhileRequestTxOpen).toMatchObject({ tenantId: tenantAId, status: 'QUEUED' });
  });

  it('findByIdForUser hanya melihat job milik tenant aktif (user pemilik sama, dipisahkan RLS)', async () => {
    const jobA = await asTenant(tenantAId, () => repository.create(createInput(tenantAId)));

    expect(
      await asTenant(tenantAId, () => repository.findByIdForUser(jobA.id, ownerId))
    ).toMatchObject({ id: jobA.id });
    expect(
      await asTenant(tenantBId, () => repository.findByIdForUser(jobA.id, ownerId))
    ).toBeNull();
    expect(await asTenant(tenantBId, () => repository.findById(jobA.id))).toBeNull();
  });

  it('jalur worker (TANPA konteks tenant): markProcessing -> markCompleted ter-commit per langkah dengan tenantId dari data job', async () => {
    const job = await asTenant(tenantAId, () => repository.create(createInput(tenantAId)));

    await repository.markProcessing(job.id, tenantAId);
    expect((await rowOf(job.id))?.status).toBe('PROCESSING');

    await repository.markCompleted(job.id, tenantAId, 'https://cdn.example.com/hasil.csv');
    const done = await rowOf(job.id);
    expect(done?.status).toBe('COMPLETED');
    expect(done?.fileUrl).toBe('https://cdn.example.com/hasil.csv');
    expect(done?.completedAt).toBeInstanceOf(Date);
  });

  it('jalur worker: markFailed tersimpan (ter-commit) walau pemanggil kemudian melempar ulang error untuk retry', async () => {
    const job = await asTenant(tenantAId, () => repository.create(createInput(tenantAId)));

    await expect(
      (async () => {
        await repository.markProcessing(job.id, tenantAId);
        await repository.markFailed(job.id, tenantAId, 'S3 down');
        throw new Error('S3 down'); // meniru `processExportJob` yang melempar ulang untuk retry BullMQ
      })()
    ).rejects.toThrow('S3 down');

    const failed = await rowOf(job.id);
    expect(failed?.status).toBe('FAILED');
    expect(failed?.errorMessage).toBe('S3 down');
  });

  it('jalur worker dengan tenantId SALAH ditolak dan baris tidak berubah', async () => {
    const job = await asTenant(tenantAId, () => repository.create(createInput(tenantAId)));

    await expect(repository.markProcessing(job.id, tenantBId)).rejects.toThrow();
    await expect(repository.markCompleted(job.id, tenantBId, 'https://x')).rejects.toThrow();
    await expect(repository.markFailed(job.id, tenantBId, 'x')).rejects.toThrow();

    const row = await rowOf(job.id);
    expect(row?.status).toBe('QUEUED');
    expect(row?.fileUrl).toBeNull();
  });

  it('jalur worker dengan tenantId null ditolak (fail-closed) dan baris tidak berubah', async () => {
    const job = await asTenant(tenantAId, () => repository.create(createInput(tenantAId)));

    await expect(repository.markProcessing(job.id, null)).rejects.toThrow();

    expect((await rowOf(job.id))?.status).toBe('QUEUED');
  });
});
