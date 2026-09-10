export interface DashboardStatsDto {
  totals: {
    users: number;
    events: number;
    products: number;
    uploads: number;
  };
  usersByRole: Record<string, number>;
  eventsByCategory: Record<string, number>;
  /** Pendaftaran user per hari, 30 hari terakhir — array terurut tanggal menaik, hari tanpa pendaftaran tetap muncul dengan count 0 (bukan hilang dari array). */
  signupsLast30Days: Array<{ date: string; count: number }>;
}

export interface AuditSummaryDto {
  /** Jumlah AuditLog per action, dalam rentang tanggal yang diminta. */
  byAction: Record<string, number>;
  totalEntries: number;
}
