import type { PrismaClient, MfaRecoveryCode } from '@prisma/client';

/**
 * Repository Layer untuk MFA — mengoperasikan dua tempat penyimpanan
 * sekaligus: kolom `mfa*` di `User` (secret & status aktif) dan tabel
 * `MfaRecoveryCode` (kode pemulihan). Digabung dalam SATU Repository
 * (bukan dipecah `UserMfaRepository`/`MfaRecoveryCodeRepository`)
 * karena keduanya SELALU berubah bersamaan dari sudut pandang siklus
 * hidup MFA satu user (aktifkan MFA = isi secret + terbitkan kode
 * pemulihan sekaligus; nonaktifkan = kosongkan keduanya sekaligus).
 */
export class MfaRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Menyimpan secret TOTP yang BARU DIBUAT (`MfaService.beginSetup`)
   * — SENGAJA TIDAK mengubah `mfaEnabled` di sini (lihat komentar
   * "dua langkah" lengkap di `MfaService.beginSetup`/`confirmSetup`).
   */
  async setPendingSecret(userId: string, encryptedSecret: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: encryptedSecret },
    });
  }

  async activateMfa(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaEnabledAt: new Date() },
    });
  }

  /**
   * Mengosongkan secret DAN menghapus seluruh recovery code dalam
   * SATU transaksi — kalau proses crash di antara keduanya, kondisi
   * paling berbahaya adalah `mfaEnabled: false` (MFA sudah nonaktif)
   * TAPI recovery code lama masih tersimpan di database, tidak
   * pernah lagi bisa dipakai (MFA sudah mati) tapi tetap "sampah"
   * kredensial yang seharusnya sudah tidak ada.
   */
  async disableMfa(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { mfaEnabled: false, mfaSecret: null, mfaEnabledAt: null },
      }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  /**
   * Mengganti SELURUH set recovery code lama dengan yang baru — dipakai
   * saat MFA pertama kali diaktifkan (`confirmSetup`) DAN saat user
   * eksplisit meminta regenerasi (kode lama semua langsung tidak
   * berlaku begitu yang baru diterbitkan, bukan ditambahkan ke
   * kumpulan lama).
   */
  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.mfaRecoveryCode.createMany({
        data: codeHashes.map((codeHash) => ({ userId, codeHash })),
      }),
    ]);
  }

  async findUnusedRecoveryCodes(userId: string): Promise<MfaRecoveryCode[]> {
    return this.prisma.mfaRecoveryCode.findMany({ where: { userId, usedAt: null } });
  }

  async markRecoveryCodeUsed(id: string): Promise<void> {
    await this.prisma.mfaRecoveryCode.update({ where: { id }, data: { usedAt: new Date() } });
  }
}
