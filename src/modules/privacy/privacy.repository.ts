import type { Prisma, PrismaClient, User } from '@prisma/client';
import { withRlsBypass } from '../../shared/tenant/tenant-context';

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

  /**
   * Temuan T15 — dijalankan lewat `withRlsBypass` (satu transaksi, `app.bypass_rls = 'on'`), BUKAN
   * `$transaction` biasa.
   *
   * Kenapa: `api_keys` (dan `products`, `events`, `webhook_endpoints`, `export_jobs`) memakai `FORCE
   * ROW LEVEL SECURITY`. Transaksi baru tanpa `app.tenant_id` atau `app.bypass_rls` melihat NOL baris,
   * jadi `apiKey.deleteMany({ where: { userId } })` "berhasil" menghapus 0 baris TANPA error — API key
   * milik user yang di-erasure tetap ada. Terbukti di PostgreSQL 16 sungguhan (`DELETE 0` tanpa bypass,
   * `DELETE 1` dengan bypass). Request HTTP tidak menolong: konteks tenant hidup di transaksi milik
   * middleware, sedangkan repository ini membuka transaksi/koneksi sendiri; job harian bahkan tidak
   * punya konteks request sama sekali.
   *
   * Pemakaian `withRlsBypass` di sini SAH: erasure memang lintas-tenant (satu user bisa punya kunci di
   * beberapa tenant) dan dipicu sistem/admin. Tercatat di `docs/data-retention-policy.md`.
   */
  async eraseUserData(userId: string): Promise<User> {
    return withRlsBypass(this.prisma, async (tx) => {
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

      // Temuan T15 — pengaman "gagal keras": `deleteMany` tidak pernah melempar error kalau yang
      // terhapus 0 baris, dan itulah persisnya cara kegagalan RLS tadi bersembunyi. Hitung sisa baris;
      // kalau ada, lempar error supaya SELURUH transaksi (termasuk scrub `User` di atas) di-rollback
      // dan kegagalannya terlihat (500 untuk self-service, job gagal + log untuk retensi otomatis),
      // bukan "erasure berhasil" yang diam-diam tidak tuntas.
      await this.assertNothingLeft(tx, userId);

      return erasedUser;
    });
  }

  private async assertNothingLeft(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const remaining: Array<[string, number]> = [
      ['oAuthAccount', await tx.oAuthAccount.count({ where: { userId } })],
      ['ssoIdentity', await tx.ssoIdentity.count({ where: { userId } })],
      ['refreshToken', await tx.refreshToken.count({ where: { userId } })],
      ['mfaRecoveryCode', await tx.mfaRecoveryCode.count({ where: { userId } })],
      ['emailVerificationToken', await tx.emailVerificationToken.count({ where: { userId } })],
      ['passwordResetToken', await tx.passwordResetToken.count({ where: { userId } })],
      ['apiKey', await tx.apiKey.count({ where: { userId } })],
      ['fileUpload', await tx.fileUpload.count({ where: { userId } })],
    ];
    const leftovers = remaining.filter(([, count]) => count > 0);
    if (leftovers.length > 0) {
      throw new Error(
        `PrivacyRepository: erasure tidak tuntas untuk user ${userId} — masih ada baris di ` +
          `${leftovers.map(([table, count]) => `${table} (${count})`).join(', ')}. ` +
          'Transaksi dibatalkan (tidak ada yang berubah).'
      );
    }
  }
}
