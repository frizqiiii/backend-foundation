import type { DashboardRepository } from './dashboard.repository';
import type { DashboardStatsDto, AuditSummaryDto } from './dashboard.dto';
import { getTenantContext } from '../../shared/tenant/tenant-context';

export class DashboardService {
  constructor(private readonly dashboardRepository: DashboardRepository) {}

  async getStats(): Promise<DashboardStatsDto> {
    // Dijalankan PARALEL (`Promise.all`), bukan berurutan — enam query
    // ini saling independen (tidak ada yang butuh hasil query lain),
    // menjalankannya berurutan hanya akan menjumlahkan latency tanpa
    // manfaat apa pun.
    // R21: `uploads` tidak punya kolom tenant, jadi di mode TENANT bernilai `null` (tidak tersedia), BUKAN 0.
    const uploadsPromise =
      getTenantContext().tenantId != null
        ? Promise.resolve(null)
        : this.dashboardRepository.countUploads();
    const [users, events, products, uploads, usersByRole, eventsByCategory, signups] =
      await Promise.all([
        this.dashboardRepository.countUsers(),
        this.dashboardRepository.countEvents(),
        this.dashboardRepository.countProducts(),
        uploadsPromise,
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
