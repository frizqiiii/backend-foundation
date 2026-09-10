import type {
  PrismaClient,
  Prisma,
  RefreshToken,
  EmailVerificationToken,
  PasswordResetToken,
  OAuthAccount,
} from '@prisma/client';
import type { OAuthProviderName } from '../../shared/types/oauth-provider';

/**
 * Klien Prisma yang berlaku di dalam SATU transaksi — dipakai oleh
 * method-method yang perlu ikut serta dalam `$transaction` interaktif
 * lintas repository (Phase 8), mis. `AuthService.resetPassword` yang
 * mengubah `User.password` (lewat `UserRepository`) DAN
 * `PasswordResetToken`/`RefreshToken` (lewat repository ini) sebagai
 * satu unit atomik.
 */
type TransactionClient = Prisma.TransactionClient;

/**
 * Repository Layer modul `auth` — SENGAJA hanya menangani tabel milik
 * modul auth (`RefreshToken`, `EmailVerificationToken`,
 * `PasswordResetToken`, `BlacklistedToken`), bukan `User`. Akses data
 * User (findByEmail, create, findById) sudah ada dan teruji di
 * `UserRepository` (`modules/users/user.repository.ts`); `AuthService`
 * memakainya langsung alih-alih membuat implementasi kedua yang
 * berisiko menyimpang dari yang asli.
 */
export class AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Menjalankan sebuah unit kerja di dalam SATU transaksi database
   * interaktif — dipakai ketika perubahan perlu menyentuh LEBIH dari
   * satu repository (mis. `UserRepository` + `AuthRepository`
   * sekaligus di `AuthService.resetPassword`) sebagai satu unit
   * atomik. Method di repository lain yang ikut serta HARUS menerima
   * `tx` yang sama ini sebagai parameter opsional terakhirnya (lihat
   * `UserRepository.update`) — bukan diam-diam memakai `this.prisma`
   * milik repository-nya sendiri, yang akan berjalan DI LUAR
   * transaksi ini.
   */
  async runInTransaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  // ---------------------------------------------------------------
  // Refresh Token
  // ---------------------------------------------------------------
  async createRefreshToken(data: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    familyId: string;
    // Finding #20 — lihat catatan lengkap di `schema.prisma` pada
    // field `familySessionExpiresAt`: batas absolut SATU family,
    // WAJIB diteruskan tanpa diubah oleh pemanggil saat rotasi
    // (bukan direset ulang seperti `expiresAt`).
    familySessionExpiresAt: Date;
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({ data });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  async findRefreshTokenById(id: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { id } });
  }

  /**
   * Sesi/device yang MASIH AKTIF milik satu user — "aktif" berarti
   * belum di-revoke DAN belum lewat `expiresAt`. Diurutkan terbaru
   * dulu (`createdAt desc`) karena kegunaan utamanya adalah endpoint
   * "device saya yang sedang login" (`GET /auth/sessions`), di mana
   * device yang baru dipakai lebih relevan ditampilkan lebih dulu.
   */
  async findActiveSessionsForUser(userId: string): Promise<RefreshToken[]> {
    return this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Total baris `RefreshToken` (status apa pun — aktif, sudah
   * di-revoke, sudah kedaluwarsa) yang PERNAH diterbitkan untuk satu
   * user, sepanjang riwayat. Dipakai HANYA untuk membedakan "ini
   * login pertama user ini" (hasil 0, sebelum baris yang baru saja
   * diterbitkan oleh `issueTokensForUser` dibuat) dari "user ini
   * sudah pernah login dari device lain sebelumnya" — login pertama
   * TIDAK PERNAH dianggap mencurigakan (memang belum ada device
   * "dikenal" untuk dibandingkan), lihat
   * `AuthService.detectAndRecordSuspiciousLogin`.
   */
  async countRefreshTokensForUser(userId: string): Promise<number> {
    return this.prisma.refreshToken.count({ where: { userId } });
  }

  /**
   * Apakah kombinasi User-Agent + IP address ini SUDAH PERNAH
   * tercatat sebelumnya untuk user tsb (status apa pun — baris yang
   * sudah di-revoke/kedaluwarsa tetap dihitung "dikenal", riwayat
   * device tidak hilang hanya karena sesinya sudah berakhir).
   * SENGAJA mencocokkan PASANGAN userAgent+ipAddress, bukan salah
   * satu saja — mencocokkan IP saja akan salah tandai jaringan
   * kantor/rumah yang dipakai banyak device sebagai "device sama",
   * mencocokkan User-Agent saja akan salah tandai device yang sama
   * dipakai dari lokasi/jaringan berbeda (mis. WFH vs kantor) sebagai
   * "device baru" tiap kali IP berubah.
   */
  async hasKnownDevice(userId: string, userAgent: string, ipAddress: string): Promise<boolean> {
    const existing = await this.prisma.refreshToken.findFirst({
      where: { userId, userAgent, ipAddress },
      select: { id: true },
    });
    return existing !== null;
  }

  async revokeRefreshToken(id: string): Promise<RefreshToken> {
    return this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Finding #19 (P1 Security Hardening) — versi ATOMIC dari
   * `revokeRefreshToken` di atas, dipakai khusus di jalur rotasi
   * (`AuthService.refresh`).
   *
   * SEBELUM ini, `AuthService.refresh` membaca `storedToken` dulu
   * (cek `revokedAt`), BARU memanggil `revokeRefreshToken(id)` yang
   * TANPA SYARAT — dua request bersamaan dengan refresh token yang
   * SAMA (mis. token curian di-replay attacker TEPAT saat client asli
   * juga refresh) bisa SAMA-SAMA lolos cek `!revokedAt` sebelum
   * salah satu sempat menulis, lalu keduanya sama-sama berhasil
   * rotasi — melewati mekanisme reuse-detection yang jadi inti Phase
   * 9. `updateMany` dengan `where: {id, revokedAt: null}` membuat
   * hanya SATU dari request yang bersamaan itu yang benar-benar
   * meng-update baris (yang lain dapat `count: 0`, artinya "sudah
   * direvoke orang/request lain barusan" — persis skenario reuse,
   * ditangani sama seperti reuse biasa oleh pemanggil).
   */
  async revokeRefreshTokenIfActive(id: string): Promise<boolean> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count > 0;
  }

  /**
   * Mencabut SELURUH sesi aktif milik satu user — dipakai saat
   * terdeteksi refresh token yang sudah di-revoke tapi dipakai lagi
   * (indikasi kuat token dicuri/direplay), lihat `AuthService.refresh`,
   * dan juga saat password direset (memaksa re-login di semua
   * device), lihat `AuthService.resetPassword`.
   */
  async revokeAllRefreshTokensForUser(userId: string, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.prisma).refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Mencabut seluruh baris SATU family (rangkaian rotasi dari satu
   * login) — dipakai saat reuse token lama terdeteksi (`AuthService.
   * refresh`). Sengaja TIDAK menyentuh family/device lain milik user
   * yang sama, beda dari `revokeAllRefreshTokensForUser` di atas yang
   * memang untuk kasus "logout dari SEMUA device" secara eksplisit.
   */
  async revokeRefreshTokenFamily(familyId: string, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.prisma).refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ---------------------------------------------------------------
  // Email Verification
  // ---------------------------------------------------------------
  async createEmailVerificationToken(data: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }): Promise<EmailVerificationToken> {
    return this.prisma.emailVerificationToken.create({ data });
  }

  async findEmailVerificationTokenByHash(
    tokenHash: string
  ): Promise<EmailVerificationToken | null> {
    return this.prisma.emailVerificationToken.findUnique({ where: { tokenHash } });
  }

  async deleteEmailVerificationToken(id: string, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.prisma).emailVerificationToken.delete({ where: { id } });
  }

  // ---------------------------------------------------------------
  // Password Reset
  // ---------------------------------------------------------------
  async createPasswordResetToken(data: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
  }): Promise<PasswordResetToken> {
    return this.prisma.passwordResetToken.create({ data });
  }

  async findPasswordResetTokenByHash(tokenHash: string): Promise<PasswordResetToken | null> {
    return this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
  }

  async deletePasswordResetToken(id: string, tx?: TransactionClient): Promise<void> {
    await (tx ?? this.prisma).passwordResetToken.delete({ where: { id } });
  }

  /**
   * Setiap permintaan forgot-password baru menggantikan token lama
   * milik user yang sama — mencegah beberapa link reset valid
   * sekaligus (kalau link lama bocor tapi tidak pernah dipakai).
   */
  async deleteAllPasswordResetTokensForUser(userId: string): Promise<void> {
    await this.prisma.passwordResetToken.deleteMany({ where: { userId } });
  }

  // ---------------------------------------------------------------
  // OAuth Account
  // ---------------------------------------------------------------
  async findOAuthAccount(
    provider: OAuthProviderName,
    providerAccountId: string
  ): Promise<OAuthAccount | null> {
    return this.prisma.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: provider as OAuthAccount['provider'],
          providerAccountId,
        },
      },
    });
  }

  async createOAuthAccount(data: {
    provider: OAuthProviderName;
    providerAccountId: string;
    userId: string;
  }): Promise<OAuthAccount> {
    return this.prisma.oAuthAccount.create({
      data: { ...data, provider: data.provider as OAuthAccount['provider'] },
    });
  }
}
