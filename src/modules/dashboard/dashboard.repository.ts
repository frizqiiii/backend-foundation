import { Prisma, type PrismaClient } from '@prisma/client';
import {
  getScopedPrisma,
  getTenantContext,
  withRlsBypass,
} from '../../shared/tenant/tenant-context';
import { assertPlatformScope } from '../../shared/tenant/stats-scope';

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

  /**
   * R21 — filter tenant untuk tabel yang punya kolom `tenant_id` (users, events, products). Mode TENANT (header ada)
   * memfilter ke tenant aktif; mode PLATFORM (tanpa header) tidak memfilter, yaitu angka global. Untuk `users` (tidak
   * ber-RLS) filter ini SATU-SATUNYA pagar; untuk events/products ia berlapis dengan RLS.
   */
  private tenantWhere(): { tenantId?: string } {
    const { tenantId } = getTenantContext();
    return tenantId ? { tenantId } : {};
  }

  /**
   * R21 — client untuk tabel ber-RLS (events, products). Mode TENANT: transaksi request yang membawa
   * `app.tenant_id` (`getScopedPrisma`). Mode PLATFORM: transaksi mandiri dengan `app.bypass_rls`, karena tanpa
   * keduanya RLS fail-closed dan angkanya selalu 0. Bypass di sini sah: rute statistik hanya dapat dicapai ADMIN
   * platform tanpa header (`requireTenantOrPlatformAdmin`), dan pemakaian ini tercatat sebagai titik bypass.
   */
  private async onRlsTables<T>(fn: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if (getTenantContext().tenantId) {
      return fn(getScopedPrisma(this.prisma) as Prisma.TransactionClient);
    }
    return withRlsBypass(this.prisma, fn);
  }

  async countUsers(): Promise<number> {
    return this.prisma.user.count({ where: { deletedAt: null, ...this.tenantWhere() } });
  }

  async countEvents(): Promise<number> {
    const where = { deletedAt: null, ...this.tenantWhere() };
    return this.onRlsTables((db) => db.event.count({ where }));
  }

  async countProducts(): Promise<number> {
    const where = { deletedAt: null, ...this.tenantWhere() };
    return this.onRlsTables((db) => db.product.count({ where }));
  }

  /** Tanpa kolom `tenant_id`: hanya mode PLATFORM (lihat `assertPlatformScope`). */
  async countUploads(): Promise<number> {
    assertPlatformScope();
    return this.prisma.fileUpload.count();
  }

  async countUsersByRole(): Promise<Array<{ role: string; count: number }>> {
    const rows = await this.prisma.user.groupBy({
      by: ['role'],
      where: { deletedAt: null, ...this.tenantWhere() },
      _count: { _all: true },
    });
    return rows.map((row: { role: string; _count: { _all: number } }) => ({
      role: row.role,
      count: row._count._all,
    }));
  }

  async countEventsByCategory(): Promise<Array<{ category: string; count: number }>> {
    const where = { deletedAt: null, ...this.tenantWhere() };
    const rows = await this.onRlsTables((db) =>
      db.event.groupBy({ by: ['category'], where, _count: { _all: true } })
    );
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
    const where = { deletedAt: null, ...this.tenantWhere() };
    const rows = await this.onRlsTables((db) =>
      db.product.groupBy({ by: ['status'], where, _count: { _all: true } })
    );
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
    const where = { deletedAt: null, ...this.tenantWhere() };
    const rows = await this.onRlsTables((db) =>
      db.product.groupBy({ by: ['category'], where, _count: { _all: true } })
    );
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
    const base = { deletedAt: null, ...this.tenantWhere() };
    // Berurutan (bukan Promise.all): di mode TENANT keduanya berbagi satu transaksi request, dan satu koneksi
    // memproses statement secara serial; di mode PLATFORM keduanya berbagi satu transaksi bypass.
    return this.onRlsTables(async (db) => {
      const upcoming = await db.event.count({ where: { ...base, date: { gte: now } } });
      const past = await db.event.count({ where: { ...base, date: { lt: now } } });
      return { upcoming, past };
    });
  }

  async signupsLast30Days(): Promise<Array<{ date: string; count: number }>> {
    const { tenantId } = getTenantContext();
    // R21: mode TENANT hanya menghitung pendaftaran user tenant itu (`users` tidak ber-RLS, ini satu-satunya pagar).
    const tenantFilter = tenantId ? Prisma.sql`AND u.tenant_id = ${tenantId}` : Prisma.empty;
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
        ${tenantFilter}
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
    // Tanpa kolom `tenant_id`: hanya mode PLATFORM (lihat `assertPlatformScope`).
    assertPlatformScope();
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
