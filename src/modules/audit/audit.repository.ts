import type { PrismaClient, AuditLog, Prisma } from '@prisma/client';
import type { CreateAuditLogInput } from './audit.types';

/**
 * Repository Layer untuk modul Audit — pola identik dengan repository
 * modul lain (Events, Products, dst): satu-satunya lapisan yang
 * langsung menyentuh Prisma Client.
 */
export class AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: CreateAuditLogInput): Promise<AuditLog> {
    return this.prisma.auditLog.create({ data });
  }

  /**
   * Riwayat LOGIN/LOGOUT milik satu user, terpaginasi — sumber data
   * untuk endpoint `GET /auth/login-history` (Phase 7). Query
   * memfilter `action IN (LOGIN, LOGOUT)` — AuditLog juga menyimpan
   * CREATE/UPDATE/DELETE, yang TIDAK relevan untuk "riwayat login".
   */
  async findByUser(
    userId: string,
    pagination: { page: number; limit: number }
  ): Promise<{ data: AuditLog[]; total: number }> {
    const skip = (pagination.page - 1) * pagination.limit;
    // Diketik eksplisit sebagai `Prisma.AuditLogWhereInput` (bukan
    // dibiarkan inferred) supaya TypeScript men-infer literal string
    // di `in: [...]` di bawah sebagai enum `AuditAction`, BUKAN
    // `string[]` biasa. SEBELUMNYA array ini memakai `as const`
    // untuk mendapat literal typing — tapi itu menghasilkan tipe
    // *readonly* tuple, sementara Prisma butuh `AuditAction[]` yang
    // *mutable* di posisi filter `in`, jadi tetap error. Dengan
    // context type di sini, `as const` tidak diperlukan lagi.
    const where: Prisma.AuditLogWhereInput = {
      userId,
      action: {
        in: [
          'LOGIN',
          'LOGOUT',
          'LOGIN_FAILED',
          'SESSION_REVOKED',
          'SESSIONS_REVOKED_ALL',
          // Suspicious Session Detection — dicatat BERBARENGAN dengan
          // baris `LOGIN` yang sama (bukan gantinya), lihat
          // `AuthService.detectAndRecordSuspiciousLogin`. Ikut
          // ditampilkan di riwayat login supaya user melihat langsung
          // login mana yang berasal dari device belum dikenal.
          'SUSPICIOUS_LOGIN_DETECTED',
        ],
      },
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pagination.limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * Phase 19 (Export Service) — SEMUA jenis action (CREATE/UPDATE/
   * DELETE/LOGIN/dst), BUKAN cuma yang login-related seperti
   * `findByUser` di atas. Dipakai `ExportService` untuk export tipe
   * `AUDIT_LOG` — laporan audit menyeluruh, beda tujuan dari "riwayat
   * login" personal satu user.
   */
  async findRecent(limit: number): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
