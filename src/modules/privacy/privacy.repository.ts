import type { PrismaClient, User } from '@prisma/client';

/**
 * Repository Layer untuk Data Retention & GDPR erasure (Fase 2).
 *
 * `eraseUserData` SENGAJA satu `$transaction` ATOMIC — kalau salah
 * satu langkah gagal (mis. koneksi database terputus di tengah
 * jalan), SEMUANYA di-rollback, tidak ada kondisi "separuh
 * ter-erasure" (mis. `RefreshToken` sudah terhapus tapi `email` user
 * belum ter-scrub, yang berarti sesi lamanya hilang TAPI datanya
 * masih identifiable — kombinasi terburuk dari dua dunia).
 *
 * DIRANCANG dengan `docs/data-retention-policy.md` sebagai rujukan
 * satu-satunya untuk apa yang di-scrub/dihapus vs yang SENGAJA
 * dipertahankan (`AuditLog` — lihat `docs/audit-log-immutability.md`
 * untuk alasan lengkapnya, dan `Product`/`Event`/`WebhookEndpoint`
 * yang dianggap konten bisnis, bukan data pribadi requester).
 */
export class PrivacyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async eraseUserData(userId: string): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const erasedUser = await tx.user.update({
        where: { id: userId },
        data: {
          // Placeholder DETERMINISTIK dari userId sendiri (bukan
          // string acak) — tetap menjamin `email` unik secara global
          // (constraint schema) tanpa perlu generate & cek tabrakan.
          email: `erased-${userId}@erased.invalid`,
          name: 'Deleted User',
          password: null,
          mfaEnabled: false,
          mfaSecret: null,
          mfaEnabledAt: null,
          // `deletedAt` ikut diisi kalau belum (erasure tanpa
          // deaktivasi akun lebih dulu tidak masuk akal — akun yang
          // datanya sudah di-scrub otomatis juga harus berhenti bisa
          // dipakai login).
          deletedAt: new Date(),
          erasedAt: new Date(),
        },
      });

      // Kredensial/identitas eksternal — TIDAK ADA nilai historis
      // dipertahankan begitu pemiliknya sudah di-erasure (beda dari
      // AuditLog yang memang punya justifikasi retensi sendiri).
      await tx.oAuthAccount.deleteMany({ where: { userId } });
      await tx.ssoIdentity.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.mfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.emailVerificationToken.deleteMany({ where: { userId } });
      await tx.passwordResetToken.deleteMany({ where: { userId } });
      await tx.apiKey.deleteMany({ where: { userId } });
      // `FileUpload` baris metadata — objek storage-nya SUDAH dihapus
      // lebih dulu oleh `PrivacyService` SEBELUM transaksi ini
      // dimulai (pola yang sama dengan `UploadService.deleteFile`:
      // hapus storage eksternal dulu, baru baris DB, supaya tidak ada
      // kondisi "baris DB hilang tapi objek storage masih ada dan
      // tidak pernah bisa ditemukan lagi lewat aplikasi").
      await tx.fileUpload.deleteMany({ where: { userId } });

      return erasedUser;
    });
  }
}
