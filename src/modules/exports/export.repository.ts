import type {
  PrismaClient,
  ExportJob,
  ExportType,
  ExportFormat,
  ExportJobStatus,
} from '@prisma/client';
import {
  getScopedPrisma,
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
