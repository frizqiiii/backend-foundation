import { randomUUID } from 'crypto';
import type { ExportType, ExportFormat } from '@prisma/client';
import type { ExportRepository, ExportJob } from './export.repository';
import type { UserRepository } from '../users/user.repository';
import type { AuditRepository } from '../audit/audit.repository';
import type { DashboardService } from '../dashboard/dashboard.service';
import type { ReportingService } from '../reporting/reporting.service';
import type { AnalyticsService } from '../analytics/analytics.service';
import { toCsv, toXlsxBuffer, toPdfBuffer } from '../../shared/utils/export';
import type { ExportColumn } from '../../shared/utils/export';
import { objectStorageProvider } from '../../shared/integrations/storage';
import { exportQueue, type ExportJobData } from '../../shared/queue/export.queue';
import { tryEnqueue } from '../../shared/queue/safe-enqueue';
import { logger } from '../../shared/logger';
import { ForbiddenError, NotFoundError } from '../../shared/utils/http-error';

const EXPORT_MAX_ROWS = 5000; // Sama dengan batas `EventService.exportEvents` (Phase 16) — konsisten satu angka di seluruh aplikasi untuk "berapa banyak baris export wajar sebelum harus dipisah/di-paginasi".

/**
 * R22 — tipe export yang sumber datanya TIDAK punya kolom `tenant_id` (`audit_logs`, `file_uploads`), sehingga tidak bisa
 * dipisah per tenant. Untuk export milik tenant, tipe ini ditolak di awal (403) alih-alih memuat data semua tenant.
 * Memisahkannya per tenant butuh migrasi skema (tambah `tenant_id` di kedua tabel), sengaja bukan bagian R22.
 */
const TENANT_UNSUPPORTED_EXPORT_TYPES: ReadonlySet<ExportType> = new Set<ExportType>([
  'AUDIT_LOG',
  'SYSTEM_STATISTICS',
  'DAILY_ACTIVE_USERS',
]);

/**
 * Export Service (Phase 19 — Enterprise Platform).
 *
 * Satu-satunya tempat yang tahu "bagaimana caranya mengekspor tiap
 * `ExportType`" — Controller HANYA memanggil `requestExport`/
 * `getExportStatus`, tidak pernah tahu detail query data atau format
 * file. `processExportJob` dipanggil dari DUA jalur (SAMA seperti
 * pola `processEmailJob` di `email.queue.ts`):
 * 1. `src/workers/export.worker.ts` — mode antrian sungguhan.
 * 2. `requestExport` di bawah — fallback SINKRON kalau Redis tidak
 *    dikonfigurasi (konsisten dengan graceful-degradation seluruh
 *    fitur berbasis queue di aplikasi ini).
 */
export class ExportService {
  constructor(
    private readonly exportRepository: ExportRepository,
    private readonly userRepository: UserRepository,
    private readonly auditRepository: AuditRepository,
    private readonly dashboardService: DashboardService,
    // Phase 20 (Reporting & Analytics Service) — dua Service baru,
    // dioper OPSIONAL (bertanda `?`) supaya SELURUH pemanggil lama
    // `new ExportService(...)` yang hanya mengoper 4 argumen (mis. di
    // test lama, kalau ada) tetap valid tanpa perlu diubah satu per
    // satu. Hanya benar-benar dibutuhkan kalau `buildDataset` dipanggil
    // dengan salah satu dari 5 `ExportType` baru — lihat pengecekan
    // eksplisit di `buildDataset` di bawah.
    private readonly reportingService?: ReportingService,
    private readonly analyticsService?: AnalyticsService
  ) {}

  async requestExport(input: {
    userId: string;
    tenantId: string | null;
    type: ExportType;
    format: ExportFormat;
  }): Promise<ExportJob> {
    if (input.tenantId != null && TENANT_UNSUPPORTED_EXPORT_TYPES.has(input.type)) {
      throw new ForbiddenError(
        'Tipe export ini belum tersedia per tenant karena sumber datanya tidak dipisah per tenant'
      );
    }

    const exportJob = await this.exportRepository.create(input);

    const jobData: ExportJobData = {
      exportJobId: exportJob.id,
      type: input.type,
      format: input.format,
      userId: input.userId,
      tenantId: input.tenantId,
    };

    if (!(await tryEnqueue(exportQueue, 'export', jobData))) {
      // Redis tidak dikonfigurasi ATAU sedang tidak terjangkau (lihat `tryEnqueue`) — proses LANGSUNG (blocking HTTP
      // response sampai selesai). Diterima sebagai trade-off yang
      // SAMA dengan fitur queue lain di aplikasi ini — tanpa Redis,
      // "asynchronous" tidak benar-benar tersedia, tapi fitur inti
      // (export-nya sendiri) tetap harus berfungsi, bukan gagal
      // total.
      await this.processExportJob(jobData);
    }

    return exportJob;
  }

  async getExportStatus(id: string, userId: string): Promise<ExportJob> {
    const exportJob = await this.exportRepository.findByIdForUser(id, userId);
    if (!exportJob) {
      throw new NotFoundError('Export tidak ditemukan');
    }
    return exportJob;
  }

  /**
   * Logic pemrosesan sesungguhnya — lihat catatan lengkap kenapa ini
   * TIDAK ditaruh di `shared/queue/export.queue.ts` (butuh akses
   * Prisma lewat repository, `shared/` tidak boleh bergantung ke
   * business logic) di komentar `export.queue.ts`.
   */
  async processExportJob(data: ExportJobData): Promise<void> {
    await this.exportRepository.markProcessing(data.exportJobId, data.tenantId);

    try {
      const { buffer, contentType, extension } = await this.generateFile(data);

      const key = `exports/${data.userId}/${randomUUID()}.${extension}`;
      const { url } = await objectStorageProvider.upload({
        key,
        body: buffer,
        contentType,
      });

      await this.exportRepository.markCompleted(data.exportJobId, data.tenantId, url);
    } catch (error) {
      logger.error(
        { err: error, exportJobId: data.exportJobId, type: data.type, format: data.format },
        'ExportService: gagal memproses export'
      );
      await this.exportRepository.markFailed(
        data.exportJobId,
        data.tenantId,
        error instanceof Error ? error.message : 'Gagal memproses export'
      );
      // Tetap dilempar ULANG — kalau diproses lewat BullMQ, ini yang
      // membuat job dianggap gagal & di-retry (`defaultJobOptions.attempts`
      // di `export.queue.ts`); status `FAILED` di atas sudah tersimpan
      // duluan supaya `GET /exports/:id` tetap akurat SELAMA retry
      // berikutnya berjalan (bukan nyangkut di `PROCESSING` selamanya).
      throw error;
    }
  }

  private async generateFile(
    data: ExportJobData
  ): Promise<{ buffer: Buffer; contentType: string; extension: string }> {
    // R22 — HANYA pembacaan data yang berjalan di dalam scope tenant (satu transaksi DB). Render file dan upload ke
    // object storage ada di luar scope, supaya transaksi tidak ditahan selama pekerjaan non-database yang bisa lambat.
    const { rows, columns, title } = await this.exportRepository.runInTenantScope(
      data.tenantId,
      () => this.buildDataset(data.type)
    );

    if (data.format === 'CSV') {
      return {
        buffer: Buffer.from(toCsv<unknown>(rows, columns), 'utf-8'),
        contentType: 'text/csv',
        extension: 'csv',
      };
    }

    if (data.format === 'XLSX') {
      return {
        buffer: await toXlsxBuffer<unknown>(rows, columns, title),
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        extension: 'xlsx',
      };
    }

    return {
      buffer: await toPdfBuffer<unknown>(rows, columns, title),
      contentType: 'application/pdf',
      extension: 'pdf',
    };
  }

  /**
   * `columns: ExportColumn<any>[]` (BUKAN `ExportColumn<never>[]`) —
   * SATU-SATUNYA titik di file ini yang tahu bentuk data tiap
   * `ExportType`, `generateFile` di atas sepenuhnya generic (tidak
   * peduli bentuk barisnya, hanya
   * meneruskan `rows`+`columns` apa adanya ke `toCsv`/`toXlsxBuffer`/
   * `toPdfBuffer`).
   */
  private async buildDataset(
    type: ExportType
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ rows: unknown[]; columns: ExportColumn<any>[]; title: string }> {
    if (type === 'USERS') {
      const { data } = await this.userRepository.findMany({ skip: 0, take: EXPORT_MAX_ROWS });
      const columns: ExportColumn<(typeof data)[number]>[] = [
        { header: 'ID', value: (row) => row.id },
        { header: 'Nama', value: (row) => row.name },
        { header: 'Email', value: (row) => row.email },
        { header: 'Role', value: (row) => row.role },
        { header: 'Dibuat', value: (row) => row.createdAt.toISOString() },
      ];
      return { rows: data, columns, title: 'Daftar Users' };
    }

    if (type === 'AUDIT_LOG') {
      const rows = await this.auditRepository.findRecent(EXPORT_MAX_ROWS);
      const columns: ExportColumn<(typeof rows)[number]>[] = [
        { header: 'Waktu', value: (row) => row.createdAt.toISOString() },
        { header: 'Action', value: (row) => row.action },
        { header: 'Entity', value: (row) => row.entity },
        { header: 'Entity ID', value: (row) => row.entityId },
        { header: 'User ID', value: (row) => row.userId },
        { header: 'IP Address', value: (row) => row.ipAddress },
      ];
      return { rows, columns, title: 'Audit Log' };
    }

    if (type === 'DASHBOARD_STATS') {
      // Bentuk datanya beda dari 2 tipe di atas (SATU objek agregat,
      // bukan array baris) — diratakan (flatten) jadi array
      // `{ metric, value }` supaya tetap muat ke bentuk tabular yang
      // dipahami `toCsv`/`toXlsxBuffer`/`toPdfBuffer` (ketiganya
      // generic untuk "array baris + kolom", bukan didesain khusus
      // untuk objek nested). `signupsLast30Days` SENDIRI sudah berupa
      // array `{date, count}` (tren harian, BUKAN satu angka total) —
      // diratakan jadi satu baris PER HARI, bukan dijejalkan sebagai
      // satu nilai (yang tidak akan muat ke kolom `string | number`).
      // R22: `getStats()` membaca konteks tenant dari AsyncLocalStorage; `generateFile` memasangnya (`runInTenantScope`)
      // baik di jalur sinkron maupun worker BullMQ.
      const stats = await this.dashboardService.getStats();
      const rows: Array<{ metric: string; value: string | number }> = [
        { metric: 'Total Users', value: stats.totals.users },
        { metric: 'Total Events', value: stats.totals.events },
        { metric: 'Total Products', value: stats.totals.products },
        { metric: 'Total Uploads', value: stats.totals.uploads ?? 'N/A' },
        ...stats.signupsLast30Days.map((day) => ({
          metric: `Signups — ${day.date}`,
          value: day.count,
        })),
        ...Object.entries(stats.usersByRole).map(([role, count]) => ({
          metric: `Users — Role ${role}`,
          value: count,
        })),
        ...Object.entries(stats.eventsByCategory).map(([category, count]) => ({
          metric: `Events — Kategori ${category}`,
          value: count,
        })),
      ];
      const columns: ExportColumn<(typeof rows)[number]>[] = [
        { header: 'Metric', value: (row) => row.metric },
        { header: 'Value', value: (row) => row.value },
      ];
      return { rows, columns, title: 'Dashboard Statistics' };
    }

    // -----------------------------------------------------------
    // Phase 20 (Reporting & Analytics Service) — 5 tipe di bawah ini
    // SEMUANYA diratakan jadi bentuk `{ metric, value }` yang SAMA
    // dengan DASHBOARD_STATS di atas, dengan alasan yang SAMA PERSIS
    // (objek agregat/nested, bukan array baris natural) — SENGAJA
    // konsisten satu bentuk flatten untuk seluruh export "statistik",
    // supaya kolom CSV/XLSX/PDF-nya selalu bisa diprediksi konsumen
    // (2 kolom: Metric, Value) apa pun jenis statistiknya.
    // -----------------------------------------------------------

    if (type === 'USER_STATISTICS') {
      const stats = await this.getReportingService().getUserStatistics();
      const rows = [
        { metric: 'Total Users', value: stats.total as string | number },
        ...Object.entries(stats.byRole).map(([role, count]) => ({
          metric: `Users — Role ${role}`,
          value: count as string | number,
        })),
        ...stats.signupsLast30Days.map((day) => ({
          metric: `Signups — ${day.date}`,
          value: day.count as string | number,
        })),
      ];
      const columns: ExportColumn<(typeof rows)[number]>[] = [
        { header: 'Metric', value: (row) => row.metric },
        { header: 'Value', value: (row) => row.value },
      ];
      return { rows, columns, title: 'User Statistics' };
    }

    if (type === 'EVENT_STATISTICS') {
      const stats = await this.getReportingService().getEventStatistics();
      const rows = [
        { metric: 'Total Events', value: stats.total as string | number },
        { metric: 'Upcoming', value: stats.upcoming as string | number },
        { metric: 'Past', value: stats.past as string | number },
        ...Object.entries(stats.byCategory).map(([category, count]) => ({
          metric: `Events — Kategori ${category}`,
          value: count as string | number,
        })),
      ];
      const columns: ExportColumn<(typeof rows)[number]>[] = [
        { header: 'Metric', value: (row) => row.metric },
        { header: 'Value', value: (row) => row.value },
      ];
      return { rows, columns, title: 'Event Statistics' };
    }

    if (type === 'PRODUCT_STATISTICS') {
      const stats = await this.getReportingService().getProductStatistics();
      const rows = [
        { metric: 'Total Products', value: stats.total as string | number },
        ...Object.entries(stats.byStatus).map(([status, count]) => ({
          metric: `Products — Status ${status}`,
          value: count as string | number,
        })),
        ...Object.entries(stats.byCategory).map(([category, count]) => ({
          metric: `Products — Kategori ${category}`,
          value: count as string | number,
        })),
      ];
      const columns: ExportColumn<(typeof rows)[number]>[] = [
        { header: 'Metric', value: (row) => row.metric },
        { header: 'Value', value: (row) => row.value },
      ];
      return { rows, columns, title: 'Product Statistics' };
    }

    if (type === 'SYSTEM_STATISTICS') {
      const stats = await this.getReportingService().getSystemStatistics();
      const rows = [
        { metric: 'Total Uploads', value: stats.totalUploads as string | number },
        ...Object.entries(stats.auditLogByAction).map(([action, count]) => ({
          metric: `Audit Log — ${action}`,
          value: count as string | number,
        })),
        ...stats.dailyActiveUsersLast30Days.map((day) => ({
          metric: `DAU — ${day.date}`,
          value: day.count as string | number,
        })),
      ];
      const columns: ExportColumn<(typeof rows)[number]>[] = [
        { header: 'Metric', value: (row) => row.metric },
        { header: 'Value', value: (row) => row.value },
      ];
      return { rows, columns, title: 'System Statistics' };
    }

    // type === 'DAILY_ACTIVE_USERS' — SATU-SATUNYA tipe export baru
    // yang barisnya SUDAH natural per-hari (bukan hasil flatten objek
    // agregat) — TIDAK perlu diratakan seperti 5 tipe di atas, langsung
    // dipakai apa adanya sebagai baris tabel.
    const dau = await this.getAnalyticsService().getDailyActiveUsers(90);
    const dauColumns: ExportColumn<(typeof dau.data)[number]>[] = [
      { header: 'Tanggal', value: (row) => row.date },
      { header: 'Daily Active Users', value: (row) => row.count },
    ];
    return { rows: dau.data, columns: dauColumns, title: 'Daily Active Users (90 Hari Terakhir)' };
  }

  /**
   * `reportingService`/`analyticsService` dioper OPSIONAL di
   * constructor (lihat komentar di sana) — dua helper ini yang
   * MEMASTIKAN pesan errornya jelas ("belum di-wire") kalau suatu saat
   * ada pemanggil yang lupa mengopernya, bukan `TypeError: Cannot read
   * properties of undefined` yang membingungkan di tengah pemrosesan
   * export job.
   */
  private getReportingService(): ReportingService {
    if (!this.reportingService) {
      throw new Error(
        'ExportService: reportingService belum di-wire — tidak bisa memproses export tipe *_STATISTICS'
      );
    }
    return this.reportingService;
  }

  private getAnalyticsService(): AnalyticsService {
    if (!this.analyticsService) {
      throw new Error(
        'ExportService: analyticsService belum di-wire — tidak bisa memproses export DAILY_ACTIVE_USERS'
      );
    }
    return this.analyticsService;
  }
}
