import type {
  PrismaClient,
  ExportJob,
  ExportType,
  ExportFormat,
  ExportJobStatus,
} from '@prisma/client';

/**
 * Repository Layer untuk `ExportJob` — pola identik dengan repository
 * modul lain di aplikasi ini (Events, Products, Audit, dst).
 */
export class ExportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: {
    userId: string;
    tenantId: string | null;
    type: ExportType;
    format: ExportFormat;
  }): Promise<ExportJob> {
    return this.prisma.exportJob.create({
      data: {
        userId: input.userId,
        tenantId: input.tenantId,
        type: input.type,
        format: input.format,
        status: 'QUEUED',
      },
    });
  }

  async findById(id: string): Promise<ExportJob | null> {
    return this.prisma.exportJob.findUnique({ where: { id } });
  }

  /**
   * `userId` WAJIB disertakan di `where` (BUKAN cuma difilter setelah
   * query) — SATU-SATUNYA cara memastikan user A tidak bisa
   * mengintip/mengunduh hasil export milik user B lewat menebak
   * `id` UUID (`GET /exports/:id`), tanpa perlu lapisan
   * authorization terpisah di Controller/Service.
   */
  async findByIdForUser(id: string, userId: string): Promise<ExportJob | null> {
    return this.prisma.exportJob.findFirst({ where: { id, userId } });
  }

  async markProcessing(id: string): Promise<void> {
    await this.prisma.exportJob.update({ where: { id }, data: { status: 'PROCESSING' } });
  }

  async markCompleted(id: string, fileUrl: string): Promise<void> {
    await this.prisma.exportJob.update({
      where: { id },
      data: { status: 'COMPLETED', fileUrl, completedAt: new Date() },
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.prisma.exportJob.update({
      where: { id },
      data: { status: 'FAILED', errorMessage, completedAt: new Date() },
    });
  }
}

export type { ExportJob, ExportJobStatus };
