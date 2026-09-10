import type { PrismaClient } from '@prisma/client';

/**
 * Repository KHUSUS untuk agregasi LINTAS-ENTITY (Phase 16 upgrade —
 * Reporting/Statistics/Admin Dashboard API). SENGAJA repository
 * tersendiri, bukan menambah method statistik ke `UserRepository`/
 * `EventRepository` masing-masing — statistik dashboard butuh
 * menggabungkan beberapa tabel sekaligus dalam satu response, jadi
 * secara alami tidak "milik" satu entity mana pun. Ini pengecualian
 * yang disengaja terhadap aturan modular (lihat `docs/architecture.md`)
 * — SATU-SATUNYA repository yang boleh query tabel di luar domainnya
 * sendiri, justru karena itulah tugasnya.
 */
export class DashboardRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async countUsers(): Promise<number> {
    return this.prisma.user.count({ where: { deletedAt: null } });
  }

  async countEvents(): Promise<number> {
    return this.prisma.event.count({ where: { deletedAt: null } });
  }

  async countProducts(): Promise<number> {
    return this.prisma.product.count({ where: { deletedAt: null } });
  }

  async countUploads(): Promise<number> {
    return this.prisma.fileUpload.count();
  }

  async countUsersByRole(): Promise<Array<{ role: string; count: number }>> {
    const rows = await this.prisma.user.groupBy({
      by: ['role'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return rows.map((row: { role: string; _count: { _all: number } }) => ({
      role: row.role,
      count: row._count._all,
    }));
  }

  async countEventsByCategory(): Promise<Array<{ category: string; count: number }>> {
    const rows = await this.prisma.event.groupBy({
      by: ['category'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return rows.map((row: { category: string; _count: { _all: number } }) => ({
      category: row.category,
      count: row._count._all,
    }));
  }

  /**
   * Phase 20 (Reporting & Analytics Service) — breakdown produk per
   * `status` (ACTIVE/INACTIVE/SOLD, dst), dipakai `ReportingService`
   * untuk "product statistics". Belum ada sebelum Phase 20 — statistik
   * dashboard lama hanya punya `countProducts` (total, tanpa breakdown).
   */
  async countProductsByStatus(): Promise<Array<{ status: string; count: number }>> {
    const rows = await this.prisma.product.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return rows.map((row: { status: string; _count: { _all: number } }) => ({
      status: row.status,
      count: row._count._all,
    }));
  }

  /**
   * Breakdown produk per `category` — padanan `countEventsByCategory`
   * di atas untuk domain Product (Phase 20).
   */
  async countProductsByCategory(): Promise<Array<{ category: string; count: number }>> {
    const rows = await this.prisma.product.groupBy({
      by: ['category'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return rows.map((row: { category: string; _count: { _all: number } }) => ({
      category: row.category,
      count: row._count._all,
    }));
  }

  /**
   * Pendaftaran user per HARI, 30 hari terakhir. Memakai `$queryRaw`
   * (bukan `groupBy` Prisma standar) karena `groupBy` TIDAK mendukung
   * truncation tanggal (`date_trunc`) — ini satu-satunya query di
   * seluruh dashboard yang lolos dari query builder Prisma biasa,
   * dengan alasan teknis yang jelas, bukan kebiasaan.
   *
   * `generate_series` dipakai supaya hari TANPA pendaftaran tetap
   * muncul di hasil dengan count 0 (bukan hilang begitu saja dari
   * array) — lebih mudah dipakai langsung oleh chart di frontend
   * tanpa perlu mengisi tanggal yang hilang secara manual di sisi
   * klien.
   */
  /**
   * Event akan datang vs sudah lewat, dibandingkan `date` terhadap
   * waktu sekarang (Phase 20) — melengkapi `countEventsByCategory`
   * untuk "event statistics" di `ReportingService`.
   */
  async countEventsUpcomingVsPast(): Promise<{ upcoming: number; past: number }> {
    const now = new Date();
    const [upcoming, past] = await Promise.all([
      this.prisma.event.count({ where: { deletedAt: null, date: { gte: now } } }),
      this.prisma.event.count({ where: { deletedAt: null, date: { lt: now } } }),
    ]);
    return { upcoming, past };
  }

  async signupsLast30Days(): Promise<Array<{ date: string; count: number }>> {
    const rows = await this.prisma.$queryRaw<Array<{ date: Date; count: bigint }>>`
      SELECT
        day::date AS date,
        COUNT(u.id)::int AS count
      FROM generate_series(
        CURRENT_DATE - INTERVAL '29 days',
        CURRENT_DATE,
        INTERVAL '1 day'
      ) AS day
      LEFT JOIN "users" u
        ON u.deleted_at IS NULL
        AND date_trunc('day', u.created_at) = day
      GROUP BY day
      ORDER BY day ASC
    `;

    return rows.map((row: { date: Date; count: bigint }) => ({
      date: row.date.toISOString().slice(0, 10),
      count: Number(row.count),
    }));
  }

  async countAuditLogsByAction(range?: {
    from: Date;
    to: Date;
  }): Promise<Array<{ action: string; count: number }>> {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['action'],
      where: range ? { createdAt: { gte: range.from, lte: range.to } } : undefined,
      _count: { _all: true },
    });
    return rows.map((row: { action: string; _count: { _all: number } }) => ({
      action: row.action,
      count: row._count._all,
    }));
  }
}
