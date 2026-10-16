import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/config/database';
import { runWithTenantContext } from '../../shared/tenant/tenant-context';
import { ExportRepository } from './export.repository';
import { ExportService } from './export.service';
import { UserRepository } from '../users/user.repository';
import { AuditRepository } from '../audit/audit.repository';
import { DashboardRepository } from '../dashboard/dashboard.repository';
import { DashboardService } from '../dashboard/dashboard.service';
import { AnalyticsRepository } from '../analytics/analytics.repository';
import { AnalyticsService } from '../analytics/analytics.service';
import { ReportingService } from '../reporting/reporting.service';
import { ForbiddenError } from '../../shared/utils/http-error';

// R22 — `ExportService` dipakai di bawah. Object storage diganti penangkap (isi file export dibaca langsung dari body
// upload, tanpa menulis ke disk/S3) dan queue dimatikan (tanpa Redis): yang diuji hanya pembangunan dataset.
jest.mock('../../shared/integrations/storage', () => ({
  objectStorageProvider: { upload: jest.fn() },
}));
jest.mock('../../shared/queue/export.queue', () => ({ exportQueue: null }));

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

/**
 * R22 — `ExportService` jalur WORKER BullMQ di bawah FORCE RLS, dengan Prisma dan Postgres SUNGGUHAN.
 *
 * Latar belakang: worker tidak lewat `tenantMiddleware`, jadi tidak punya konteks tenant. Sebelum perbaikan,
 * `buildDataset` berjalan tanpa konteks: `UserRepository.findMany` tidak memfilter tenant (tabel `users` tidak ber-RLS)
 * sehingga file export admin tenant C memuat user tenant D; repository statistik jatuh ke mode PLATFORM (angka global
 * lewat bypass RLS). Perbaikannya: dataset dibangun di dalam scope tenant milik job (`runInTenantScope`).
 *
 * Yang dibuktikan, semuanya lewat `processExportJob` TANPA konteks tenant (persis worker) dan membaca isi file hasilnya:
 *  1. KONTROL — tanpa konteks, `findMany` melihat user dua tenant (mekanisme kebocoran aslinya).
 *  2. USERS: file hanya memuat user tenant job.
 *  3. DASHBOARD_STATS dan *_STATISTICS: angka hanya milik tenant job.
 *  4. AUDIT_LOG di worker gagal (tabel tanpa kolom tenant), tidak ada file yang di-upload.
 *  5. `requestExport` menolak AUDIT_LOG/SYSTEM_STATISTICS/DAILY_ACTIVE_USERS untuk tenant (403) dan tidak membuat job.
 *  6. Job dengan tenantId null ditolak (fail-closed), tidak ada file yang di-upload.
 */
describe('ExportService jalur worker di bawah FORCE RLS — database sungguhan (R22)', () => {
  const exportRepository = new ExportRepository(prisma);
  const userRepository = new UserRepository(prisma);
  const dashboardRepository = new DashboardRepository(prisma);
  const analyticsRepository = new AnalyticsRepository(prisma);
  const service = new ExportService(
    exportRepository,
    userRepository,
    new AuditRepository(prisma),
    new DashboardService(dashboardRepository),
    new ReportingService(dashboardRepository, analyticsRepository),
    new AnalyticsService(analyticsRepository)
  );
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { objectStorageProvider: mockStorage } = jest.requireMock(
    '../../shared/integrations/storage'
  );

  const marker = `r22-${randomUUID()}`;
  let tenantCId: string;
  let tenantDId: string;
  let ownerId: string;
  const userIds: string[] = [];
  const emailOf = (label: string): string => `${marker}-${label}@example.com`;

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

  type JobType = Parameters<ExportRepository['create']>[0]['type'];

  // Meniru alur produksi: API membuat baris job (di dalam request tenant), lalu WORKER memprosesnya TANPA konteks tenant.
  async function createJob(tenantId: string, type: JobType) {
    return asTenant(tenantId, () =>
      exportRepository.create({ userId: ownerId, tenantId, type, format: 'CSV' })
    );
  }

  function uploadedCsv(): string {
    const calls = mockStorage.upload.mock.calls;
    return (calls[calls.length - 1][0].body as Buffer).toString('utf-8');
  }

  async function runWorker(tenantId: string, type: JobType): Promise<string> {
    const job = await createJob(tenantId, type);
    await service.processExportJob({
      exportJobId: job.id,
      type,
      format: 'CSV',
      userId: ownerId,
      tenantId,
    });
    return uploadedCsv();
  }

  const metric = (csv: string, name: string): string | undefined =>
    new RegExp(`^${name},(.*?)\\r?$`, 'm').exec(csv)?.[1];

  beforeAll(async () => {
    const tenantC = await prisma.tenant.create({
      data: { slug: `exports-w-c-${randomUUID()}`, name: 'Exports Worker C' },
    });
    const tenantD = await prisma.tenant.create({
      data: { slug: `exports-w-d-${randomUUID()}`, name: 'Exports Worker D' },
    });
    tenantCId = tenantC.id;
    tenantDId = tenantD.id;

    const owner = await prisma.user.create({
      data: { email: emailOf('owner'), name: 'Owner', password: null },
    });
    ownerId = owner.id;
    userIds.push(owner.id);

    for (const [label, tenantId] of [
      ['c1', tenantCId],
      ['c2', tenantCId],
      ['d1', tenantDId],
    ] as const) {
      const user = await prisma.user.create({
        data: { email: emailOf(label), name: `Worker ${label}`, password: null, tenantId },
      });
      userIds.push(user.id);
    }

    await withBypass(async (tx) => {
      // Tenant C: 2 events, 3 products. Tenant D: 1 event, 1 product.
      for (const tenantId of [tenantCId, tenantCId, tenantDId]) {
        await tx.event.create({
          data: {
            title: `${marker} event`,
            category: 'Musik',
            location: 'Jakarta',
            date: new Date('2030-01-01'),
            ownerId,
            tenantId,
          },
        });
      }
      for (const tenantId of [tenantCId, tenantCId, tenantCId, tenantDId]) {
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

  beforeEach(() => {
    mockStorage.upload.mockReset();
    mockStorage.upload.mockResolvedValue({ url: 'https://storage.example.com/exports/hasil.csv' });
  });

  afterAll(async () => {
    await withBypass(async (tx) => {
      const tenantIds = [tenantCId, tenantDId];
      await tx.exportJob.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.event.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await tx.product.deleteMany({ where: { tenantId: { in: tenantIds } } });
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantCId, tenantDId] } } });
  });

  it('KONTROL: tanpa konteks tenant, UserRepository.findMany melihat user DUA tenant (mekanisme kebocoran aslinya)', async () => {
    const { data } = await userRepository.findMany({ skip: 0, take: 5000 });
    const emails = data.map((u) => u.email);

    expect(emails).toContain(emailOf('c1'));
    expect(emails).toContain(emailOf('d1'));
  });

  it('USERS (worker): file hanya memuat user tenant job', async () => {
    const csvC = await runWorker(tenantCId, 'USERS');
    expect(csvC).toContain(emailOf('c1'));
    expect(csvC).toContain(emailOf('c2'));
    expect(csvC).not.toContain(emailOf('d1'));
    expect(csvC).not.toContain(emailOf('owner'));

    const csvD = await runWorker(tenantDId, 'USERS');
    expect(csvD).toContain(emailOf('d1'));
    expect(csvD).not.toContain(emailOf('c1'));
    expect(csvD).not.toContain(emailOf('c2'));
  });

  it('USERS (worker): job tercatat COMPLETED dengan tenantId yang benar', async () => {
    const job = await createJob(tenantCId, 'USERS');
    await service.processExportJob({
      exportJobId: job.id,
      type: 'USERS',
      format: 'CSV',
      userId: ownerId,
      tenantId: tenantCId,
    });

    const row = await withBypass((tx) => tx.exportJob.findUnique({ where: { id: job.id } }));
    expect(row).toMatchObject({ status: 'COMPLETED', tenantId: tenantCId });
  });

  it('DASHBOARD_STATS (worker): angka hanya milik tenant job, uploads N/A', async () => {
    const csvC = await runWorker(tenantCId, 'DASHBOARD_STATS');
    expect(metric(csvC, 'Total Users')).toBe('2');
    expect(metric(csvC, 'Total Events')).toBe('2');
    expect(metric(csvC, 'Total Products')).toBe('3');
    expect(metric(csvC, 'Total Uploads')).toBe('N/A');

    const csvD = await runWorker(tenantDId, 'DASHBOARD_STATS');
    expect(metric(csvD, 'Total Users')).toBe('1');
    expect(metric(csvD, 'Total Events')).toBe('1');
    expect(metric(csvD, 'Total Products')).toBe('1');
  });

  it('USER/EVENT/PRODUCT_STATISTICS (worker): angka hanya milik tenant job', async () => {
    expect(metric(await runWorker(tenantCId, 'USER_STATISTICS'), 'Total Users')).toBe('2');
    expect(metric(await runWorker(tenantCId, 'EVENT_STATISTICS'), 'Total Events')).toBe('2');
    expect(metric(await runWorker(tenantCId, 'PRODUCT_STATISTICS'), 'Total Products')).toBe('3');
    expect(metric(await runWorker(tenantDId, 'EVENT_STATISTICS'), 'Total Events')).toBe('1');
  });

  it('AUDIT_LOG (worker): gagal karena tabel tanpa kolom tenant, job FAILED, tidak ada file di-upload', async () => {
    const job = await createJob(tenantCId, 'AUDIT_LOG');

    await expect(
      service.processExportJob({
        exportJobId: job.id,
        type: 'AUDIT_LOG',
        format: 'CSV',
        userId: ownerId,
        tenantId: tenantCId,
      })
    ).rejects.toThrow(/admin platform/i);

    const row = await withBypass((tx) => tx.exportJob.findUnique({ where: { id: job.id } }));
    expect(row?.status).toBe('FAILED');
    expect(mockStorage.upload).not.toHaveBeenCalled();
  });

  it('requestExport menolak AUDIT_LOG, SYSTEM_STATISTICS, dan DAILY_ACTIVE_USERS untuk tenant (403) tanpa membuat job', async () => {
    // Dihitung sebagai SELISIH: tes worker sebelumnya sengaja membuat satu job AUDIT_LOG untuk tenant yang sama lewat
    // repository (melewati penolakan di `requestExport`), jadi jumlah absolut bukan 0.
    const countJobs = (): Promise<number> =>
      withBypass((tx) =>
        tx.exportJob.count({
          where: {
            tenantId: tenantCId,
            type: { in: ['AUDIT_LOG', 'SYSTEM_STATISTICS', 'DAILY_ACTIVE_USERS'] },
          },
        })
      );
    const before = await countJobs();

    for (const type of ['AUDIT_LOG', 'SYSTEM_STATISTICS', 'DAILY_ACTIVE_USERS'] as const) {
      await expect(
        asTenant(tenantCId, () =>
          service.requestExport({ userId: ownerId, tenantId: tenantCId, type, format: 'CSV' })
        )
      ).rejects.toThrow(ForbiddenError);
    }

    expect(await countJobs()).toBe(before);
  });

  it('job dengan tenantId null ditolak (fail-closed), tidak ada file di-upload', async () => {
    const job = await createJob(tenantCId, 'USERS');

    await expect(
      service.processExportJob({
        exportJobId: job.id,
        type: 'USERS',
        format: 'CSV',
        userId: ownerId,
        tenantId: null,
      })
    ).rejects.toThrow();

    expect(mockStorage.upload).not.toHaveBeenCalled();
  });
});
