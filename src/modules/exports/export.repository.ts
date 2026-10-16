import type {
  PrismaClient,
  ExportJob,
  ExportType,
  ExportFormat,
  ExportJobStatus,
} from '@prisma/client';
import {
  getScopedPrisma,
  getTenantContext,
  runInTenantTransaction,
  withTenantScope,
} from '../../shared/tenant/tenant-context';

/**
 * Repository Layer untuk `ExportJob` — pola identik dengan repository
 * modul lain di aplikasi ini (Events, Products, Audit, dst).
 *
 * R19 — `export_jobs` ber-FORCE RLS. Dua konteks pemakaian, keduanya harus membawa `app.tenant_id`:
 *  - API (request): `create` dan `findByIdForUser` lewat klien tenant.
 *  - Worker BullMQ (`markProcessing/Completed/Failed`): tidak lewat `tenantMiddleware`, jadi tenant diambil dari data
 *    job (`tenantId`) dan dipasang per panggilan lewat `withTenantScope`.
 * `create` memakai transaksi mandiri (`runInTenantTransaction`) agar barisnya SUDAH ter-commit sebelum job di-enqueue.
 */
export class ExportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: {
    userId: string;
    tenantId: string | null;
    type: ExportType;
    format: ExportFormat;
  }): Promise<ExportJob> {
    return runInTenantTransaction(this.prisma, input.tenantId, () =>
      getScopedPrisma(this.prisma).exportJob.create({
        data: {
          userId: input.userId,
          tenantId: input.tenantId,
          type: input.type,
          format: input.format,
          status: 'QUEUED',
        },
      })
    );
  }

  async findById(id: string): Promise<ExportJob | null> {
    return getScopedPrisma(this.prisma).exportJob.findUnique({ where: { id } });
  }

  /**
   * `userId` WAJIB disertakan di `where` (BUKAN cuma difilter setelah
   * query) — SATU-SATUNYA cara memastikan user A tidak bisa
   * mengintip/mengunduh hasil export milik user B lewat menebak
   * `id` UUID (`GET /exports/:id`), tanpa perlu lapisan
   * authorization terpisah di Controller/Service.
   */
  async findByIdForUser(id: string, userId: string): Promise<ExportJob | null> {
    return getScopedPrisma(this.prisma).exportJob.findFirst({ where: { id, userId } });
  }

  /**
   * R22 — menjalankan pembangunan dataset export di dalam scope TENANT milik job.
   *
   * Worker BullMQ tidak lewat `tenantMiddleware`, jadi `getTenantContext()` kosong di sana. Tanpa scope ini,
   * `UserRepository.findMany` tidak memfilter tenant dan repository statistik jatuh ke mode PLATFORM (angka global lewat
   * bypass RLS): export admin tenant A memuat data semua tenant. Di sini `tenantId` dari data job dipasang sebagai
   * konteks + transaksi ber-`app.tenant_id` (`withTenantScope`), sehingga kode yang SAMA dengan jalur request berlaku.
   *
   * Dengan transaksi request yang masih aktif (fallback sinkron) transaksi itu dipakai apa adanya.
   *
   * FAIL-CLOSED: tanpa tenant (`null`) dan tanpa konteks tenant aktif, ditolak. Meneruskannya sama dengan membangun dataset
   * tanpa scope sama sekali (global). Export tanpa tenant memang tidak didukung (`export_jobs` ber-RLS menolak INSERT-nya).
   */
  async runInTenantScope<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
    if (tenantId == null && getTenantContext().db == null) {
      throw new Error('ExportRepository: export wajib terikat tenant (tenantId job kosong)');
    }
    return withTenantScope(this.prisma, tenantId, fn);
  }

  async markProcessing(id: string, tenantId: string | null): Promise<void> {
    await withTenantScope(this.prisma, tenantId, () =>
      getScopedPrisma(this.prisma).exportJob.update({
        where: { id },
        data: { status: 'PROCESSING' },
      })
    );
  }

  async markCompleted(id: string, tenantId: string | null, fileUrl: string): Promise<void> {
    await withTenantScope(this.prisma, tenantId, () =>
      getScopedPrisma(this.prisma).exportJob.update({
        where: { id },
        data: { status: 'COMPLETED', fileUrl, completedAt: new Date() },
      })
    );
  }

  async markFailed(id: string, tenantId: string | null, errorMessage: string): Promise<void> {
    await withTenantScope(this.prisma, tenantId, () =>
      getScopedPrisma(this.prisma).exportJob.update({
        where: { id },
        data: { status: 'FAILED', errorMessage, completedAt: new Date() },
      })
    );
  }
}

export type { ExportJob, ExportJobStatus };
