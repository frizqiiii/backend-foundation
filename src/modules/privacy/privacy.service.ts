import bcrypt from 'bcrypt';
import type { PrivacyRepository } from './privacy.repository';
import type { UserRepository } from '../users/user.repository';
import type { UploadRepository } from '../upload/upload.repository';
import { objectStorageProvider } from '../../shared/integrations/storage';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../../shared/utils/http-error';
import { logger } from '../../shared/logger';

export interface ErasureResult {
  userId: string;
  erasedAt: Date;
}

/**
 * Fase 2 (Kelompok 2 — Data retention & GDPR erasure). Lihat
 * `docs/data-retention-policy.md` untuk kebijakan lengkapnya — apa
 * yang di-scrub/dihapus vs SENGAJA dipertahankan (`AuditLog`, dengan
 * justifikasi hukum GDPR Art. 17(3) sendiri).
 */
export class PrivacyService {
  constructor(
    private readonly privacyRepository: PrivacyRepository,
    private readonly userRepository: UserRepository,
    private readonly uploadRepository: UploadRepository
  ) {}

  /**
   * Self-service — user MENGHAPUS DATANYA SENDIRI. Konfirmasi
   * password WAJIB (pola sama dengan `MfaController.disable`) karena
   * ini operasi IRREVERSIBLE — access token yang dicuri/masih aktif
   * di device lain TIDAK CUKUP untuk memicu penghapusan permanen,
   * user harus membuktikan lagi tahu password-nya.
   */
  async requestSelfErasure(userId: string, password: string): Promise<ErasureResult> {
    const user = await this.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User tidak ditemukan');
    }
    if (!user.password) {
      // Akun SSO/OAuth-only tanpa password lokal (lihat
      // `SsoService`/`OAuthService` — `password: null` untuk akun
      // JIT-provisioned) — tidak ada apa pun untuk dicocokkan sebagai
      // "konfirmasi". Erasure tetap boleh jalan (`authMiddleware`
      // sudah membuktikan sesi ini sah), cuma langkah konfirmasi
      // password-nya dilewati untuk kasus ini secara eksplisit,
      // bukan diam-diam gagal atau diam-diam dianggap valid.
      return this.erase(userId);
    }
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedError('Password salah — penghapusan data dibatalkan.');
    }
    return this.erase(userId);
  }

  /** Admin-triggered — dipanggil job retensi otomatis MAUPUN endpoint admin manual. */
  async eraseForUser(userId: string): Promise<ErasureResult> {
    // Temuan T15 — HARUS `findByIdIncludingDeleted`: target utama jalur ini (job retensi 30 hari)
    // adalah akun yang SUDAH soft-deleted, yang disembunyikan oleh `findById`.
    const user = await this.userRepository.findByIdIncludingDeleted(userId);
    if (!user) {
      throw new NotFoundError('User tidak ditemukan');
    }
    if (user.erasedAt) {
      throw new BadRequestError('Data user ini sudah pernah di-erasure sebelumnya.');
    }
    return this.erase(userId);
  }

  private async erase(userId: string): Promise<ErasureResult> {
    // Objek storage (file upload) dihapus DULU, DI LUAR transaksi
    // database — pola yang SAMA persis dengan `UploadService.deleteFile`
    // (hapus eksternal dulu, baru baris DB, supaya tidak ada baris DB
    // hilang sementara objek storage-nya masih ada dan tak lagi bisa
    // ditemukan lewat aplikasi mana pun).
    const files = await this.uploadRepository.findByUser(userId);
    for (const file of files) {
      try {
        await objectStorageProvider.delete(file.key);
      } catch (error) {
        // TIDAK menghentikan seluruh proses erasure hanya karena SATU
        // objek storage gagal dihapus (mis. sudah terhapus manual,
        // atau storage provider sedang gangguan) — dicatat jelas
        // supaya bisa ditindaklanjuti manual, tapi PII di database
        // (tujuan utama GDPR erasure) tetap harus tuntas ter-scrub.
        logger.error(
          { err: error, fileId: file.id, key: file.key, userId },
          'PrivacyService: gagal menghapus objek storage saat erasure — dilanjutkan, PII di database tetap di-scrub'
        );
      }
    }

    const erasedUser = await this.privacyRepository.eraseUserData(userId);
    logger.info({ userId }, 'PrivacyService: data pribadi user berhasil di-erasure');

    return { userId: erasedUser.id, erasedAt: erasedUser.erasedAt as Date };
  }
}
