import type { DashboardRepository } from '../dashboard/dashboard.repository';
import type { AnalyticsRepository } from '../analytics/analytics.repository';
import type {
  UserStatisticsDto,
  EventStatisticsDto,
  ProductStatisticsDto,
  SystemStatisticsDto,
} from './reporting.dto';

const DAU_TREND_DAYS = 30;

/**
 * Service Layer modul `reporting` (Phase 20 — Reporting & Analytics
 * Service). SENGAJA TIDAK menjalankan query Prisma-nya sendiri —
 * murni mengomposisikan ulang query yang SUDAH ADA di
 * `DashboardRepository` (dan `AnalyticsRepository` untuk tren DAU)
 * jadi 4 response berorientasi-resource (`user`/`event`/`product`/
 * `system`) alih-alih satu blob gabungan (`DashboardService.getStats`).
 * Konsumen yang hanya butuh statistik event, misalnya, tidak perlu
 * memfilter sendiri dari response yang jauh lebih besar.
 *
 * Ini BUKAN duplikasi `DashboardService` — kedua Service ini
 * mengonsumsi repository yang sama tapi membentuk ulang hasilnya
 * dengan cara berbeda untuk audiens berbeda: `DashboardService`
 * untuk tampilan admin dashboard (satu layar ringkas), `ReportingService`
 * ini untuk kebutuhan reporting/export per-domain (lihat
 * `ExportService.buildDataset`, tipe `*_STATISTICS`).
 */
export class ReportingService {
  constructor(
    private readonly dashboardRepository: DashboardRepository,
    private readonly analyticsRepository: AnalyticsRepository
  ) {}

  async getUserStatistics(): Promise<UserStatisticsDto> {
    const [total, byRoleRows, signups] = await Promise.all([
      this.dashboardRepository.countUsers(),
      this.dashboardRepository.countUsersByRole(),
      this.dashboardRepository.signupsLast30Days(),
    ]);

    return {
      total,
      byRole: Object.fromEntries(byRoleRows.map((row) => [row.role, row.count])),
      signupsLast30Days: signups,
    };
  }

  async getEventStatistics(): Promise<EventStatisticsDto> {
    const [total, byCategoryRows, upcomingVsPast] = await Promise.all([
      this.dashboardRepository.countEvents(),
      this.dashboardRepository.countEventsByCategory(),
      this.dashboardRepository.countEventsUpcomingVsPast(),
    ]);

    return {
      total,
      byCategory: Object.fromEntries(byCategoryRows.map((row) => [row.category, row.count])),
      upcoming: upcomingVsPast.upcoming,
      past: upcomingVsPast.past,
    };
  }

  async getProductStatistics(): Promise<ProductStatisticsDto> {
    const [total, byStatusRows, byCategoryRows] = await Promise.all([
      this.dashboardRepository.countProducts(),
      this.dashboardRepository.countProductsByStatus(),
      this.dashboardRepository.countProductsByCategory(),
    ]);

    return {
      total,
      byStatus: Object.fromEntries(byStatusRows.map((row) => [row.status, row.count])),
      byCategory: Object.fromEntries(byCategoryRows.map((row) => [row.category, row.count])),
    };
  }

  async getSystemStatistics(): Promise<SystemStatisticsDto> {
    const [totalUploads, auditByActionRows, dau] = await Promise.all([
      this.dashboardRepository.countUploads(),
      this.dashboardRepository.countAuditLogsByAction(),
      this.analyticsRepository.dailyActiveUsers(DAU_TREND_DAYS),
    ]);

    return {
      totalUploads,
      auditLogByAction: Object.fromEntries(auditByActionRows.map((row) => [row.action, row.count])),
      dailyActiveUsersLast30Days: dau,
    };
  }
}
