import { logger } from '../../shared/logger';
import type { AuditRepository } from './audit.repository';
import type { AuditActorContext } from './audit.types';

export interface PaginatedResult<T> {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface LoginHistoryEntry {
  action:
    | 'LOGIN'
    | 'LOGOUT'
    | 'LOGIN_FAILED'
    | 'SESSION_REVOKED'
    | 'SESSIONS_REVOKED_ALL'
    | 'SUSPICIOUS_LOGIN_DETECTED';
  // Derivasi langsung dari `action` (`false` hanya untuk
  // `LOGIN_FAILED`) — disediakan sebagai field terpisah supaya
  // konsumen (frontend) tidak perlu tahu detail nilai enum `action`
  // hanya untuk menampilkan ikon sukses/gagal. `SESSION_REVOKED`/
  // `SESSIONS_REVOKED_ALL` (Phase 17) dianggap "success" juga —
  // keduanya aksi keamanan yang BERHASIL dilakukan user (mencabut
  // sesi), bukan percobaan yang gagal seperti `LOGIN_FAILED`.
  success: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
}

/**
 * Service Layer untuk modul Audit.
 *
 * PRINSIP UTAMA: mencatat audit log TIDAK PERNAH boleh menggagalkan
 * request bisnis yang sedang berjalan. Kalau user berhasil menghapus
 * event tapi audit log-nya gagal ditulis (mis. DB sedang di bawah
 * beban tinggi), user tetap harus menerima response sukses — event-
 * nya memang sudah terhapus sungguhan. Karena itu setiap method di
 * sini SELALU membungkus pemanggilan repository dengan try/catch dan
 * TIDAK PERNAH melempar ulang error ke pemanggil; kegagalan hanya
 * di-log sebagai warning untuk diselidiki lewat log, bukan
 * mengganggu alur utama.
 *
 * Ini pola yang sama sekali berbeda dari Service lain di aplikasi ini
 * (mis. `EventService`) yang MEMANG harus melempar error ke atas —
 * audit logging adalah "efek samping" observability, bukan bagian
 * dari kontrak bisnis inti yang diharapkan si pemanggil API.
 */
export class AuditService {
  constructor(private readonly auditRepository: AuditRepository) {}

  private async record(
    action:
      | 'CREATE'
      | 'UPDATE'
      | 'DELETE'
      | 'LOGIN'
      | 'LOGOUT'
      | 'LOGIN_FAILED'
      | 'SESSION_REVOKED'
      | 'SESSIONS_REVOKED_ALL'
      | 'SUSPICIOUS_LOGIN_DETECTED',
    entity: string,
    entityId: string | null,
    actor: AuditActorContext
  ): Promise<void> {
    try {
      await this.auditRepository.create({ ...actor, action, entity, entityId });
    } catch (error) {
      logger.warn(
        { err: error, action, entity, entityId, userId: actor.userId },
        'AuditService: gagal mencatat audit log — request utama tetap dilanjutkan'
      );
    }
  }

  async logCreate(entity: string, entityId: string, actor: AuditActorContext): Promise<void> {
    await this.record('CREATE', entity, entityId, actor);
  }

  async logUpdate(entity: string, entityId: string, actor: AuditActorContext): Promise<void> {
    await this.record('UPDATE', entity, entityId, actor);
  }

  async logDelete(entity: string, entityId: string, actor: AuditActorContext): Promise<void> {
    await this.record('DELETE', entity, entityId, actor);
  }

  /**
   * `entityId` untuk LOGIN/LOGOUT diisi dengan `userId` requester itu
   * sendiri (entity-nya "User", ID-nya user yang login/logout) —
   * bukan `null`, supaya query "riwayat login user X" tetap bisa
   * memakai index komposit `[entity, entityId]` yang sama seperti
   * audit CRUD lainnya.
   */
  async logLogin(actor: AuditActorContext): Promise<void> {
    await this.record('LOGIN', 'User', actor.userId, actor);
  }

  async logLogout(actor: AuditActorContext): Promise<void> {
    await this.record('LOGOUT', 'User', actor.userId, actor);
  }

  /**
   * Percobaan login yang GAGAL — HANYA dipanggil ketika kredensial
   * mengacu ke akun yang benar-benar ada (`actor.userId` sudah
   * diketahui, tidak pernah `null` di jalur pemanggilan saat ini),
   * supaya pemilik akun bisa melihat "seseorang mencoba masuk ke akun
   * Anda tapi gagal" lewat `GET /auth/login-history`. Percobaan
   * dengan email yang sama sekali tidak terdaftar TIDAK dicatat di
   * sini — tidak ada userId untuk dikaitkan, dan tidak ada riwayat
   * login siapa pun yang relevan untuk itu.
   */
  async logLoginFailed(actor: AuditActorContext): Promise<void> {
    await this.record('LOGIN_FAILED', 'User', actor.userId, actor);
  }

  /**
   * Phase 17 (Session Management Enterprise) — mencabut SATU sesi/
   * device tertentu (`DELETE /auth/sessions/:id`). `entityId` diisi
   * `sessionId` (ID baris `RefreshToken` yang dicabut) — BUKAN
   * `actor.userId` seperti LOGIN/LOGOUT — supaya query "siapa yang
   * mencabut sesi tertentu" tetap bisa memakai index komposit
   * `[entity, entityId]`, konsisten dengan pola audit CRUD (di sini
   * "entity"-nya adalah sesi yang dicabut, bukan User pelakunya).
   */
  async logSessionRevoked(sessionId: string, actor: AuditActorContext): Promise<void> {
    await this.record('SESSION_REVOKED', 'RefreshToken', sessionId, actor);
  }

  /**
   * Phase 17 — logout dari SEMUA device sekaligus
   * (`DELETE /auth/sessions`). `entityId` diisi `actor.userId` (sama
   * seperti LOGIN/LOGOUT) karena aksi ini tidak menyasar satu baris
   * sesi tertentu — targetnya adalah SELURUH sesi milik user tsb.
   */
  async logAllSessionsRevoked(actor: AuditActorContext): Promise<void> {
    await this.record('SESSIONS_REVOKED_ALL', 'User', actor.userId, actor);
  }

  /**
   * Login BERHASIL dari device (kombinasi User-Agent + IP address)
   * yang belum pernah tercatat sebelumnya untuk user ini — dicatat
   * BERBARENGAN dengan `logLogin` (bukan gantinya), lihat
   * `AuthService.detectAndRecordSuspiciousLogin`. `entityId` diisi
   * `actor.userId`, konsisten dengan LOGIN/LOGOUT di atas.
   */
  async logSuspiciousLogin(actor: AuditActorContext): Promise<void> {
    await this.record('SUSPICIOUS_LOGIN_DETECTED', 'User', actor.userId, actor);
  }

  /**
   * Riwayat login/logout milik satu user (Phase 7 "login history") —
   * SENGAJA TIDAK memakai pola try/catch-lalu-warn seperti method
   * `log*` di atas. Method-method itu menulis EFEK SAMPING best-effort
   * yang boleh diam-diam gagal; method ini adalah PEMBACAAN yang
   * hasilnya langsung dikirim sebagai response ke user yang secara
   * eksplisit meminta riwayat login miliknya sendiri — kalau database
   * gagal dibaca, user HARUS tahu lewat error yang jelas (lewat
   * `errorHandler` terpusat), bukan diam-diam menerima daftar kosong
   * yang terlihat seperti "tidak ada riwayat login sama sekali".
   */
  async getLoginHistory(
    userId: string,
    pagination: { page: number; limit: number }
  ): Promise<PaginatedResult<LoginHistoryEntry>> {
    const { data, total } = await this.auditRepository.findByUser(userId, pagination);

    return {
      data: data.map((entry) => {
        const action = entry.action as
          | 'LOGIN'
          | 'LOGOUT'
          | 'LOGIN_FAILED'
          | 'SESSION_REVOKED'
          | 'SESSIONS_REVOKED_ALL'
          | 'SUSPICIOUS_LOGIN_DETECTED';
        return {
          action,
          success: action !== 'LOGIN_FAILED',
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          createdAt: entry.createdAt,
        };
      }),
      meta: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.ceil(total / pagination.limit),
      },
    };
  }

  /**
   * Verifikasi integritas SELURUH hash chain audit log (Fase 2 —
   * immutability) — dipanggil job terjadwal (lihat
   * `verify-audit-chain-integrity.job.ts`) MAUPUN endpoint admin
   * on-demand (`GET /auth/admin/audit/integrity`). SENGAJA TIDAK
   * memakai pola try/catch-lalu-warn seperti method `log*` di atas —
   * sama seperti `getLoginHistory`, ini PEMBACAAN yang hasilnya
   * langsung relevan bagi pemanggilnya; kegagalan (baik error teknis
   * maupun chain yang TERBUKTI rusak) harus terlihat jelas, bukan
   * ditelan diam-diam.
   */
  async verifyIntegrity(): Promise<
    { valid: true } | { valid: false; brokenAt: { id: string; reason: string } }
  > {
    return this.auditRepository.verifyChainIntegrity();
  }
}
