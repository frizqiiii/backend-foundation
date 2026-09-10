import type { DashboardRepository } from './dashboard.repository';
import type { DashboardStatsDto, AuditSummaryDto } from './dashboard.dto';

export class DashboardService {
  constructor(private readonly dashboardRepository: DashboardRepository) {}

  async getStats(): Promise<DashboardStatsDto> {
    // Dijalankan PARALEL (`Promise.all`), bukan berurutan — enam query
    // ini saling independen (tidak ada yang butuh hasil query lain),
    // menjalankannya berurutan hanya akan menjumlahkan latency tanpa
    // manfaat apa pun.
    const [users, events, products, uploads, usersByRole, eventsByCategory, signups] =
      await Promise.all([
        this.dashboardRepository.countUsers(),
        this.dashboardRepository.countEvents(),
        this.dashboardRepository.countProducts(),
        this.dashboardRepository.countUploads(),
        this.dashboardRepository.countUsersByRole(),
        this.dashboardRepository.countEventsByCategory(),
        this.dashboardRepository.signupsLast30Days(),
      ]);

    return {
      totals: { users, events, products, uploads },
      usersByRole: Object.fromEntries(usersByRole.map((row) => [row.role, row.count])),
      eventsByCategory: Object.fromEntries(
        eventsByCategory.map((row) => [row.category, row.count])
      ),
      signupsLast30Days: signups,
    };
  }

  async getAuditSummary(range?: { from: Date; to: Date }): Promise<AuditSummaryDto> {
    const rows = await this.dashboardRepository.countAuditLogsByAction(range);
    const byAction = Object.fromEntries(rows.map((row) => [row.action, row.count]));
    const totalEntries = rows.reduce((sum, row) => sum + row.count, 0);

    return { byAction, totalEntries };
  }
}
