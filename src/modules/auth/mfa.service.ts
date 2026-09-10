import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
// `otplib` v13 mengganti API `authenticator` dengan primitif baru
// (`TOTP`, `generate`, `verify`, dst) yang tidak backward compatible.
// SENGAJA dikunci ke v12 (`^12.0.1` di package.json) untuk API
// `authenticator.{generateSecret,keyuri,check,generate}` yang dipakai
// di seluruh file ini — upgrade ke v13 butuh migrasi API secara
// eksplisit, bukan sekadar bump versi.
import { authenticator } from 'otplib';
import type { User } from '@prisma/client';
import type { MfaRepository } from './mfa.repository';
import { encryptionService } from '../../shared/security/encryption.service';
import { env } from '../../shared/config/env';
import { BadRequestError, UnauthorizedError } from '../../shared/utils/http-error';
import type { MfaSetupResponseDto } from './mfa.dto';

const RECOVERY_CODE_COUNT = 8;
/** Label yang muncul di authenticator app (Google Authenticator, Authy,
 * dst) di samping nama akun — murni kosmetik, tidak punya efek keamanan. */
const ISSUER = 'Backend Foundation';

export class MfaService {
  constructor(private readonly mfaRepository: MfaRepository) {}

  /**
   * Langkah 1/2 setup MFA. Menghasilkan secret TOTP baru dan
   * menyimpannya (TERENKRIPSI, lihat `encryptionService`) di
   * `User.mfaSecret` — TAPI `mfaEnabled` TETAP `false` sampai
   * `confirmSetup` di bawah berhasil.
   *
   * KENAPA DUA LANGKAH (bukan langsung aktif begitu secret dibuat) —
   * user yang salah scan QR, atau authenticator app-nya salah setup,
   * tidak boleh berakhir dengan MFA "aktif" tapi kode yang mereka
   * hasilkan TIDAK PERNAH cocok dengan yang diharapkan server — itu
   * berarti terkunci permanen dari akun sendiri. Memaksa satu
   * verifikasi kode yang BENAR-BENAR berhasil sebelum
   * `mfaEnabled: true` memastikan user sudah punya cara valid untuk
   * login sebelum MFA benar-benar diwajibkan.
   *
   * Memanggil `beginSetup` lagi sebelum `confirmSetup` (mis. user
   * scan ulang) SENGAJA menimpa secret pending sebelumnya — tidak ada
   * bahaya menimpa sesuatu yang belum pernah aktif dipakai.
   */
  async beginSetup(user: Pick<User, 'id' | 'email'>): Promise<MfaSetupResponseDto> {
    // Finding #13 (P1 Security Hardening) — SEBELUMNYA
    // `generateSecret()` dipanggil TANPA argumen, diam-diam
    // bergantung ke default library (`otplib` v12: 10 byte -> secret
    // base32 16 karakter, 80-bit entropy). Test file ini sendiri
    // punya komentar yang menyebut "otplib default secret length"
    // sebagai 32 karakter (160-bit, 20 byte) — niat awalnya memang
    // kekuatan 160-bit (standar umum TOTP, sesuai rekomendasi RFC
    // 4226/6238 untuk HOTP/TOTP secret), tapi diam-diam melemah ke
    // 80-bit begitu versi/default library berubah, TANPA ada yang
    // sadar (baru ketahuan sekarang lewat test yang akhirnya benar-
    // benar bisa dijalankan). `20` di sini membuat kekuatan secret
    // EKSPLISIT di kode kita sendiri — tidak lagi bergantung pada
    // default implisit pihak ketiga yang bisa berubah kapan saja.
    const secret = authenticator.generateSecret(20);
    await this.mfaRepository.setPendingSecret(user.id, encryptionService.encrypt(secret));

    const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
    return { secret, otpauthUrl };
  }

  /**
   * Langkah 2/2 — memverifikasi kode TOTP pertama BENAR-BENAR cocok
   * dengan secret yang dibuat `beginSetup`, baru mengaktifkan MFA.
   * Recovery code diterbitkan DI SINI (bukan langkah terpisah) — user
   * hanya akan pernah melihatnya SATU KALI, jadi harus muncul di
   * response yang SAMA dengan konfirmasi berhasil, tidak ada
   * kesempatan kedua untuk "lihat lagi nanti".
   */
  async confirmSetup(user: User, code: string): Promise<string[]> {
    if (!user.mfaSecret) {
      throw new BadRequestError(
        'Belum ada setup MFA yang berjalan — mulai dari POST /auth/mfa/setup'
      );
    }

    const secret = encryptionService.decrypt(user.mfaSecret);
    if (!authenticator.check(code, secret)) {
      throw new UnauthorizedError('Kode MFA tidak valid');
    }

    const recoveryCodes = this.generateRecoveryCodes();
    const codeHashes = await Promise.all(
      recoveryCodes.map((rawCode) => bcrypt.hash(rawCode, env.BCRYPT_SALT_ROUNDS))
    );

    await this.mfaRepository.replaceRecoveryCodes(user.id, codeHashes);
    await this.mfaRepository.activateMfa(user.id);

    return recoveryCodes;
  }

  /**
   * Menonaktifkan MFA — re-autentikasi (password) sudah divalidasi
   * SEBELUM method ini dipanggil (lihat `MfaController.disable`).
   */
  async disable(user: Pick<User, 'id'>): Promise<void> {
    await this.mfaRepository.disableMfa(user.id);
  }

  /**
   * Dipakai `AuthService.verifyMfaLogin` untuk menyelesaikan login.
   * Coba kode TOTP dulu (jalur normal), baru fallback ke recovery
   * code (untuk user yang kehilangan akses ke authenticator app-nya)
   * — TOTP dicoba lebih dulu karena tidak mengonsumsi apa pun (bisa
   * dicoba berkali-kali tanpa efek samping), beda dari recovery code
   * yang sekali pakai.
   */
  async verifyCode(user: User, code: string): Promise<boolean> {
    if (!user.mfaSecret) {
      return false;
    }

    const secret = encryptionService.decrypt(user.mfaSecret);
    if (authenticator.check(code, secret)) {
      return true;
    }

    return this.tryConsumeRecoveryCode(user.id, code);
  }

  private async tryConsumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const unusedCodes = await this.mfaRepository.findUnusedRecoveryCodes(userId);

    for (const entry of unusedCodes) {
      // eslint-disable-next-line no-await-in-loop -- jumlah recovery code per user dibatasi kecil (RECOVERY_CODE_COUNT), paralelisasi tidak sepadan dengan kompleksitasnya
      const matches = await bcrypt.compare(code, entry.codeHash);
      if (matches) {
        await this.mfaRepository.markRecoveryCodeUsed(entry.id);
        return true;
      }
    }

    return false;
  }

  /**
   * Format `XXXXX-XXXXX` (10 karakter hex acak, dipisah tanda hubung
   * di tengah untuk keterbacaan) — cukup entropi (5 byte = 40 bit per
   * kode) untuk tidak ditebak, cukup pendek untuk diketik manual dari
   * secarik kertas kalau perlu.
   */
  private generateRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
      const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
  }
}
