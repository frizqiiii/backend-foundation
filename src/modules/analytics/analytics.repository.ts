import type { PrismaClient } from '@prisma/client';

/**
 * Repository Layer modul `analytics` (Phase 20 — Reporting & Analytics
 * Service).
 *
 * SENGAJA repository terpisah dari `DashboardRepository`, walau
 * keduanya sama-sama "agregasi lintas-user" — beda sifat data:
 * `DashboardRepository` menghitung STATE saat ini (berapa total user/
 * event/product SEKARANG), sedangkan repository ini menghitung
 * AKTIVITAS dari waktu ke waktu (berapa user AKTIF per hari). Metrik
 * time-series seperti ini akan terus bertambah jenisnya (mis. nanti
 * "weekly active users", "retention cohort") — mengelompokkannya di
 * satu tempat sendiri mencegah `DashboardRepository` membengkak jadi
 * dua tanggung jawab berbeda sekaligus.
 */
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Daily Active Users — jumlah user UNIK yang berhasil login per
   * hari, `days` hari terakhir (termasuk hari ini). "Aktif" di sini
   * didefinisikan sebagai "berhasil login" (action `LOGIN` di
   * `AuditLog`, SUMBER YANG SAMA dipakai `AuthService`/
   * `AuditService.logLogin` — bukan query kedua yang bisa menyimpang
   * dari apa yang sebenarnya tercatat sebagai login sukses).
   *
   * Memakai `$queryRaw` + `generate_series` — pola IDENTIK dengan
   * `DashboardRepository.signupsLast30Days` (lihat komentar lengkap
   * di sana) — hari TANPA login tetap muncul dengan count 0, bukan
   * hilang dari array, supaya konsumen (chart/export) tidak perlu
   * mengisi tanggal yang hilang secara manual.
   *
   * `COUNT(DISTINCT ...)` — SATU user yang login berkali-kali dalam
   * satu hari (mis. logout lalu login lagi) tetap dihitung SATU kali
   * untuk hari itu, konsisten dengan makna "Daily ACTIVE Users"
   * (jumlah user yang aktif, bukan jumlah event login).
   */
  async dailyActiveUsers(days: number): Promise<Array<{ date: string; count: number }>> {
    const rows = await this.prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
      SELECT
        day::date AS date,
        COUNT(DISTINCT al.user_id)::int AS count
      FROM generate_series(
        CURRENT_DATE - (${days - 1} * INTERVAL '1 day'),
        CURRENT_DATE,
        INTERVAL '1 day'
      ) AS day
      LEFT JOIN "audit_logs" al
        ON al.action = 'LOGIN'
        AND date_trunc('day', al.created_at) = day
      GROUP BY day
      ORDER BY day ASC
    `;

    return rows.map((row: { date: Date; count: bigint }) => ({
      date: row.date.toISOString().slice(0, 10),
      count: Number(row.count),
    }));
  }
}
