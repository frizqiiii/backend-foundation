export interface UserStatisticsDto {
  total: number;
  byRole: Record<string, number>;
  /** Pendaftaran user per hari, 30 hari terakhir — sama persis dengan `DashboardStatsDto.signupsLast30Days`. */
  signupsLast30Days: Array<{ date: string; count: number }>;
}

export interface EventStatisticsDto {
  total: number;
  byCategory: Record<string, number>;
  upcoming: number;
  past: number;
}

export interface ProductStatisticsDto {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface SystemStatisticsDto {
  totalUploads: number;
  /** Ringkasan AuditLog per action, seluruh waktu (tanpa filter rentang tanggal — beda dari `AuditSummaryDto` di modul dashboard yang menerima range opsional). */
  auditLogByAction: Record<string, number>;
  /** Tren 30 hari terakhir — dipakai bersama untuk menilai kesehatan sistem dari sisi keterlibatan user, bukan cuma total statis. */
  dailyActiveUsersLast30Days: Array<{ date: string; count: number }>;
}
