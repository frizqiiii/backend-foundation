import { randomUUID, createHash } from 'crypto';
import type { PrismaClient, AuditLog, Prisma } from '@prisma/client';
import type { CreateAuditLogInput } from './audit.types';

const CHAIN_STATE_ID = 'singleton';

/**
 * Bentuk kanonis satu baris `AuditLog` untuk keperluan hashing — SATU
 * fungsi ini dipakai baik saat MEMBUAT hash (di `create`) maupun saat
 * MEMVERIFIKASI ulang (di `verifyChainIntegrity`), supaya keduanya
 * DIJAMIN memakai serialisasi yang identik persis. `JSON.stringify`
 * pada object literal dengan urutan key yang SELALU SAMA (bukan
 * `concat_ws` manual) — deterministik selama fungsi ini konsisten
 * dipanggil, dan otomatis menangani null dengan benar tanpa perlu
 * `coalesce` manual.
 */
function canonicalize(row: {
  id: string;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}): string {
  return JSON.stringify({
    id: row.id,
    userId: row.userId,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  });
}

function computeHash(canonical: string, previousHash: string | null): string {
  return createHash('sha256')
    .update(`${canonical}|${previousHash ?? ''}`)
    .digest('hex');
}

/**
 * Repository Layer untuk modul Audit — pola identik dengan repository
 * modul lain (Events, Products, dst): satu-satunya lapisan yang
 * langsung menyentuh Prisma Client.
 *
 * Fase 2 (Audit log immutability) — `create` SEKARANG membangun hash
 * chain (lihat `docs/audit-log-immutability.md` untuk desain
 * lengkapnya): setiap baris menyimpan hash atas isinya SENDIRI +
 * hash baris SEBELUMNYA, sehingga mengubah/menyisipkan/menghapus
 * satu baris pun akan ketahuan lewat `verifyChainIntegrity()`. Ini
 * lapis KEDUA — lapis pertama (trigger database `prevent_audit_log_mutation`,
 * lihat migration) sudah memblokir UPDATE/DELETE sama sekali; hash
 * chain tetap berguna sebagai bukti independen kalau lapis pertama
 * itu entah bagaimana terlewati (superuser DB, restore backup, dll).
 */
export class AuditRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: CreateAuditLogInput): Promise<AuditLog> {
    const id = randomUUID();
    const createdAt = new Date();

    return this.prisma.$transaction(async (tx) => {
      // `FOR UPDATE` pada baris singleton — MENYERIALKAN penulisan
      // chain antar request/worker CONCURRENT. Tanpa ini, dua audit
      // log yang dibuat BERSAMAAN bisa sama-sama membaca `lastHash`
      // yang sama dan menghasilkan chain yang bercabang (dua baris
      // ber-previousHash sama), merusak jaminan tamper-evidence-nya.
      const rows = await tx.$queryRaw<{ lastHash: string | null }[]>`
        SELECT last_hash AS "lastHash" FROM audit_chain_state WHERE id = ${CHAIN_STATE_ID} FOR UPDATE
      `;
      const previousHash = rows[0]?.lastHash ?? null;

      const hash = computeHash(
        canonicalize({
          id,
          userId: data.userId,
          action: data.action,
          entity: data.entity,
          entityId: data.entityId,
          ipAddress: data.ipAddress,
          userAgent: data.userAgent,
          createdAt,
        }),
        previousHash
      );

      const created = await tx.auditLog.create({
        data: { ...data, id, createdAt, hash, previousHash },
      });

      await tx.$executeRaw`
        INSERT INTO audit_chain_state (id, last_hash, updated_at)
        VALUES (${CHAIN_STATE_ID}, ${hash}, now())
        ON CONFLICT (id) DO UPDATE SET last_hash = ${hash}, updated_at = now()
      `;

      return created;
    });
  }

  /**
   * Memverifikasi SELURUH hash chain dari awal — operasi BERAT
   * (membaca semua baris berhash), dipanggil manual/lewat job
   * terjadwal (mis. harian), BUKAN di setiap request. Mengembalikan
   * baris PERTAMA yang rusak (kalau ada) beserta alasannya.
   *
   * PENTING — menelusuri chain lewat TAUTAN HASH-nya sendiri
   * (previousHash -> hash), BUKAN mengurutkan berdasarkan
   * createdAt/id: ketahuan lewat pengujian konkurensi nyata bahwa
   * `createdAt` bisa collide di milidetik yang sama saat banyak
   * audit log dibuat nyaris bersamaan, dan `id` (UUID acak) sama
   * sekali tidak berkorelasi dengan urutan chain SEBENARNYA (yang
   * ditentukan urutan lock `FOR UPDATE` di `create`, bukan timestamp)
   * — sortir by timestamp akan salah melaporkan chain valid sebagai
   * rusak dalam skenario itu. Menelusuri via tautan hash tidak
   * bergantung pada urutan baris sama sekali.
   */
  async verifyChainIntegrity(): Promise<
    { valid: true } | { valid: false; brokenAt: { id: string; reason: string } }
  > {
    const rows = await this.prisma.auditLog.findMany({
      where: { hash: { not: null } },
    });

    // Deteksi FORK secara eksplisit: dua baris berbeda menunjuk
    // previousHash yang SAMA berarti chain bercabang (race condition
    // yang lolos dari FOR UPDATE, atau manipulasi) — harus dilaporkan,
    // bukan diam-diam dipilih salah satu oleh Map di bawah.
    const byPreviousHash = new Map<string | null, (typeof rows)[number]>();
    for (const row of rows) {
      if (byPreviousHash.has(row.previousHash)) {
        return {
          valid: false,
          brokenAt: {
            id: row.id,
            reason: `Chain bercabang — lebih dari satu baris menunjuk previousHash yang sama (${row.previousHash ?? 'genesis'}).`,
          },
        };
      }
      byPreviousHash.set(row.previousHash, row);
    }

    let current = byPreviousHash.get(null);
    let visited = 0;
    let expectedPreviousHash: string | null = null;
    while (current) {
      const expectedHash = computeHash(canonicalize(current), expectedPreviousHash);
      if (expectedHash !== current.hash) {
        return {
          valid: false,
          brokenAt: {
            id: current.id,
            reason: 'Hash tidak cocok dengan isi baris saat ini (kontennya diubah setelah dibuat).',
          },
        };
      }
      visited++;
      expectedPreviousHash = current.hash;
      current = byPreviousHash.get(current.hash as string);
    }

    if (visited !== rows.length) {
      return {
        valid: false,
        brokenAt: {
          id: 'N/A',
          reason: `${rows.length - visited} baris tidak terhubung ke chain utama dari genesis (kemungkinan genesis ganda atau baris disisipkan di luar jalur normal).`,
        },
      };
    }

    return { valid: true };
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
