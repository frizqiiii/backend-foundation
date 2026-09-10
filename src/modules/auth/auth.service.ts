import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import type { UserRepository } from '../users/user.repository';
import type { UserResponseDto } from '../users/user.dto';
import type { AuthRepository } from './auth.repository';
import type { AuditService } from '../audit/audit.service';
import type { MfaService } from './mfa.service';
import type { RoleName } from '../../shared/types/role';
import type {
  RegisterDto,
  LoginDto,
  RefreshDto,
  VerifyEmailDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  AuthResponseDto,
  RefreshResponseDto,
} from './auth.dto';
import type { VerifyMfaLoginDto, MfaRequiredResponseDto } from './mfa.dto';
import {
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  TooManyRequestsError,
  NotFoundError,
} from '../../shared/utils/http-error';
import { env } from '../../shared/config/env';
import { logger } from '../../shared/logger';
import { jwtHelper } from '../../shared/utils/jwt';
import { generateRefreshToken, hashRefreshToken } from '../../shared/utils/refresh-token';
import { generateSecureToken, hashSecureToken } from '../../shared/utils/secure-token';
import { tokenBlacklist } from '../../shared/utils/token-blacklist';
import { enqueueEmailJob } from '../../shared/queue/email.queue';
import { invalidateCache } from '../../shared/utils/cache';
import { cacheKeys } from '../../shared/utils/cache-keys';
import {
  checkAccountLock,
  recordFailedAttempt,
  resetAttempts,
} from '../../shared/security/login-attempt-tracker';
import { parseUserAgent } from '../../shared/utils/user-agent';
import type { SessionDto } from './auth.dto';

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 jam
/**
 * Finding #20 (P1 Security Hardening) — batas absolut satu SESI
 * (family), terlepas dari seberapa aktif dipakai. `REFRESH_TOKEN_TTL_MS`
 * di atas hanya melindungi dari sesi yang IDLE (tidak dipakai 7 hari);
 * sesi yang terus dipakai sebelum kedaluwarsa (login sekali, lalu
 * auto-refresh terus-menerus, mis. aplikasi mobile) tidak pernah
 * dipaksa re-autentikasi tanpa batas ini — lihat komentar
 * `familySessionExpiresAt` di `schema.prisma` untuk detail lengkap.
 */
const ABSOLUTE_SESSION_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari

/**
 * Konteks device requester (Phase 7) — SELALU opsional di seluruh
 * Service, karena `OAuthService` (pemanggil `issueTokensForUser` yang
 * lain) belum tentu selalu diperbarui bersamaan; device yang tidak
 * diketahui cukup tersimpan sebagai `null`, bukan membuat penerbitan
 * token gagal.
 */
export interface DeviceContext {
  userAgent: string | null;
  ipAddress: string | null;
}

/**
 * Finding #17 (P1 Security Hardening) — hash bcrypt TETAP (bukan
 * password/user manapun) yang dipakai SEMATA-MATA supaya
 * `bcrypt.compare` tetap dipanggil bahkan ketika user tidak
 * ditemukan sama sekali di `login()` di bawah.
 *
 * SEBELUM fix ini: kalau email tidak terdaftar, fungsi langsung
 * `throw` TANPA pernah memanggil `bcrypt.compare` — jauh lebih
 * cepat dibanding jalur "email ada tapi password salah" (yang
 * menjalankan hashing ~50-100ms). Pesan error-nya sama persis
 * ("Email atau password salah"), TAPI waktu responsnya berbeda —
 * celah timing-attack klasik (CWE-208) yang membiarkan penyerang
 * menebak email mana yang terdaftar hanya dengan mengukur waktu
 * respons, walau tidak pernah melihat error message yang berbeda.
 *
 * Nilai ini di-hardcode (bukan digenerate ulang tiap start) karena
 * tidak pernah dipakai untuk memverifikasi kredensial apa pun secara
 * sungguhan — hanya sebagai "beban kerja" CPU yang setara supaya
 * profil waktu kedua jalur (user ada/tidak ada) tidak bisa
 * dibedakan dari luar.
 */
const DUMMY_BCRYPT_HASH = '$2b$10$8nLV18cLdwWvv2tPcr5V7eX4CjYJaA9BrgiXnxiho7.ImBFfRvxVm';

/**
 * Service Layer modul `auth` — satu-satunya tempat yang boleh
 * menerbitkan/mencabut token di seluruh aplikasi.
 *
 * Dependensi ke `UserRepository` (milik modul `users`) adalah
 * pengecualian SADAR terhadap aturan "modul tidak saling import":
 * autentikasi secara inheren beroperasi pada entitas User yang sama,
 * jadi menduplikasi akses datanya di sini hanya akan menciptakan dua
 * sumber kebenaran yang bisa saling menyimpang.
 */
export class AuthService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly authRepository: AuthRepository,
    // Dipakai HANYA untuk mencatat percobaan login yang gagal ke
    // `LoginHistoryEntry` (Phase 1 upgrade) — login/logout yang
    // SUKSES tetap dicatat di `AuthController` seperti sebelumnya,
    // bukan di sini, supaya tidak dobel.
    private readonly auditService: AuditService,
    // Phase 12 (Enterprise Security) — dependensi SADAR ke modul yang
    // sama (`auth`), bukan modul lain: MFA adalah bagian tak
    // terpisahkan dari alur login (lihat `login`/`verifyMfaLogin` di
    // bawah), sama seperti kenapa `AuthService` boleh bergantung ke
    // `UserRepository`.
    private readonly mfaService: MfaService
  ) {}

  /**
   * Akun baru dibuat dengan `emailVerifiedAt: null` (default skema).
   * Token verifikasi diterbitkan, lalu pengiriman emailnya di-ANTRE
   * lewat `enqueueEmailJob` (`shared/queue/email.queue.ts`) — HTTP
   * response endpoint ini tidak pernah menunggu proses "pengiriman"
   * selesai. Worker terpisah (`src/workers/email.worker.ts`) yang
   * benar-benar memprosesnya (lewat `mailer.ts` — dev-mode stub, lihat
   * catatan di file itu: BUKAN pengiriman email sungguhan).
   */
  async register(input: RegisterDto): Promise<UserResponseDto> {
    const existingUser = await this.userRepository.findByEmail(input.email);
    if (existingUser) {
      throw new ConflictError('Email sudah terdaftar');
    }

    const hashedPassword = await bcrypt.hash(input.password, env.BCRYPT_SALT_ROUNDS);

    const user = await this.userRepository.create({
      email: input.email,
      password: hashedPassword,
      name: input.name,
    });

    await this.issueEmailVerificationToken(user.id, user.email);

    return this.toUserResponseDto(user);
  }

  /**
   * Memverifikasi kredensial, lalu menerbitkan sepasang token:
   * - Access token (JWT, umur pendek) — dipakai di header Authorization
   *   pada tiap request ke rute terproteksi.
   * - Refresh token (opaque, umur panjang, tersimpan sebagai hash di
   *   database) — HANYA dipakai untuk menukar access token baru lewat
   *   endpoint `/auth/refresh`, tidak pernah dikirim di header biasa.
   *
   * Pesan error login dibuat generik untuk email tidak ditemukan
   * maupun password salah — mencegah *user enumeration attack*.
   *
   * Login DITOLAK (403) kalau email belum diverifikasi — keputusan
   * keamanan sadar: akun yang belum terbukti pemiliknya benar-benar
   * memiliki email tersebut tidak diberi akses penuh.
   */
  /**
   * Phase 12 — return type SEKARANG `AuthResponseDto | MfaRequiredResponseDto`.
   * `AuthResponseDto` TIDAK berubah bentuknya sama sekali (backward
   * compatible untuk `user.mfaEnabled === false`, yaitu SEMUA user
   * yang ada sebelum Phase 12); `MfaRequiredResponseDto` adalah
   * bentuk BARU yang hanya muncul untuk user yang benar-benar
   * mengaktifkan MFA. Lihat `AuthController.login` untuk cara
   * membedakan keduanya di response HTTP.
   */
  async login(
    dto: LoginDto,
    deviceContext?: DeviceContext
  ): Promise<AuthResponseDto | MfaRequiredResponseDto> {
    // Dicek PALING AWAL, sebelum query user apa pun — kalau akun ini
    // sedang terkunci, tidak ada gunanya (dan berisiko memberi celah
    // timing attack tambahan) untuk tetap lanjut melakukan query DB +
    // `bcrypt.compare`. Lihat `login-attempt-tracker.ts` untuk detail
    // ambang batas & durasi kunci.
    const lockStatus = await checkAccountLock(dto.email);
    if (lockStatus.locked) {
      const minutes = Math.ceil((lockStatus.remainingSeconds ?? 0) / 60);
      throw new TooManyRequestsError(
        `Terlalu banyak percobaan login gagal. Coba lagi dalam ${minutes} menit.`
      );
    }

    const user = await this.userRepository.findByEmail(dto.email);
    if (!user) {
      // `bcrypt.compare` TETAP dipanggil (terhadap hash palsu di atas,
      // bukan hash user manapun) walau kita sudah tahu tidak akan
      // pernah cocok — semata-mata supaya durasi jalur ini menyerupai
      // jalur "password salah" di bawah. Lihat komentar
      // `DUMMY_BCRYPT_HASH` untuk penjelasan lengkap kenapa ini perlu.
      await bcrypt.compare(dto.password, DUMMY_BCRYPT_HASH);
      await recordFailedAttempt(dto.email);
      throw new UnauthorizedError('Email atau password salah');
    }

    if (!user.password) {
      // Akun ini HANYA pernah login lewat OAuth (Google/GitHub) —
      // tidak pernah membuat password sama sekali. Pesan dibuat
      // spesifik (bukan disamakan dengan "email/password salah")
      // karena ini bukan kesalahan kredensial, melainkan memang
      // metode login yang salah dipakai — tidak ada risiko user
      // enumeration tambahan karena keberadaan email SUDAH terbukti
      // lewat langkah find di atas. TIDAK dihitung sebagai percobaan
      // gagal — user tidak salah memasukkan kredensial apa pun, dia
      // hanya memakai form yang salah.
      throw new UnauthorizedError(
        'Akun ini terdaftar lewat Google/GitHub. Gunakan tombol login yang sesuai.'
      );
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      await recordFailedAttempt(dto.email);
      await this.auditService.logLoginFailed({
        userId: user.id,
        ...(deviceContext ?? { ipAddress: null, userAgent: null }),
      });
      throw new UnauthorizedError('Email atau password salah');
    }

    if (!user.emailVerifiedAt) {
      // Kredensial BENAR tapi akun belum diverifikasi — tetap dicatat
      // sebagai percobaan gagal (bukan sekadar diam) karena ini
      // sinyal berharga untuk pemilik akun: seseorang sudah tahu
      // password yang benar.
      await this.auditService.logLoginFailed({
        userId: user.id,
        ...(deviceContext ?? { ipAddress: null, userAgent: null }),
      });
      throw new ForbiddenError('Email belum diverifikasi. Silakan cek email Anda.');
    }

    // Kredensial benar-benar valid — hitungan kegagalan sebelumnya
    // (kalau ada, tapi belum sampai mengunci akun) tidak boleh
    // terwarisi ke percobaan login berikutnya yang sah.
    await resetAttempts(dto.email);

    // Phase 12 — password benar TAPI MFA aktif: BELUM menerbitkan
    // access/refresh token sungguhan. Client wajib menyelesaikan
    // langkah kedua lewat `verifyMfaLogin` di bawah, memakai
    // `challengeToken` ini. Tidak dicatat sebagai audit login
    // sukses/gagal apa pun di sini — dari sudut pandang keamanan,
    // titik ini bukan keduanya: kredensial pertama benar, tapi login
    // belum selesai.
    if (user.mfaEnabled) {
      return { mfaRequired: true, challengeToken: jwtHelper.signMfaChallenge(user.id) };
    }

    return this.issueTokensForUser(user, deviceContext);
  }

  /**
   * Langkah kedua login untuk user dengan MFA aktif — menukar
   * `challengeToken` (dari `login()` di atas) + kode TOTP/recovery
   * yang valid dengan access+refresh token sungguhan lewat
   * `issueTokensForUser`, PERSIS jalur yang sama dengan login biasa,
   * supaya tidak ada implementasi kedua yang bisa menyimpang (sama
   * alasannya seperti kenapa `OAuthService` juga memanggil
   * `issueTokensForUser`, lihat komentar di method itu).
   */
  async verifyMfaLogin(
    dto: VerifyMfaLoginDto,
    deviceContext?: DeviceContext
  ): Promise<AuthResponseDto> {
    let userId: string;
    try {
      userId = jwtHelper.verifyMfaChallenge(dto.challengeToken).userId;
    } catch {
      throw new UnauthorizedError('Challenge token tidak valid atau sudah kedaluwarsa');
    }

    // Finding #21 (P1 Security Hardening) — SEBELUMNYA langkah ini
    // HANYA dilindungi `authRateLimiter` generik (10 request/15 menit
    // PER IP, dipasang di seluruh prefix `/auth/*`, lihat `app.ts`) —
    // cukup untuk mencegah brute-force murni dari SATU IP (10 percobaan
    // untuk ruang kode 6-digit/1 juta kombinasi tidak realistis
    // ditembus), TAPI tidak ada apa pun yang mengunci PER-AKUN kalau
    // penyerang punya banyak IP (mis. botnet) — beda dari `login()` di
    // atas yang sudah dilindungi `checkAccountLock`/`recordFailedAttempt`
    // PER EMAIL, independen dari IP sumbernya. Skenario paling relevan:
    // penyerang yang SUDAH punya password korban (mis. dari kebocoran
    // data situs lain) tapi terhambat MFA — MFA seharusnya jadi lapisan
    // proteksi TERAKHIR, bukan satu-satunya yang cuma dijaga rate-limit
    // per-IP yang mudah didistribusikan.
    //
    // Identifier `mfa:<userId>` (BUKAN email) sengaja dipakai supaya
    // namespace-nya terpisah total dari lock password di `login()` —
    // gagal MFA berkali-kali tidak boleh ikut mengunci user keluar dari
    // percobaan LOGIN (password)-nya, begitu pula sebaliknya; keduanya
    // representasi risiko yang berbeda (kredensial bocor vs
    // device/authenticator hilang).
    const mfaLockIdentifier = `mfa:${userId}`;
    const lockStatus = await checkAccountLock(mfaLockIdentifier);
    if (lockStatus.locked) {
      const minutes = Math.ceil((lockStatus.remainingSeconds ?? 0) / 60);
      throw new TooManyRequestsError(
        `Terlalu banyak percobaan kode MFA gagal. Coba lagi dalam ${minutes} menit.`
      );
    }

    const user = await this.userRepository.findById(userId);
    if (!user || !user.mfaEnabled) {
      // User terhapus, ATAU MFA-nya sudah dinonaktifkan di antara
      // login() dan langkah ini — kedua kasus berarti challenge token
      // ini tidak lagi berlaku sama sekali.
      throw new UnauthorizedError('Challenge token tidak valid atau sudah kedaluwarsa');
    }

    const isCodeValid = await this.mfaService.verifyCode(user, dto.code);
    if (!isCodeValid) {
      await recordFailedAttempt(mfaLockIdentifier);
      await this.auditService.logLoginFailed({
        userId: user.id,
        ...(deviceContext ?? { ipAddress: null, userAgent: null }),
      });
      throw new UnauthorizedError('Kode MFA tidak valid');
    }

    // Kode benar-benar valid — hitungan kegagalan MFA sebelumnya (kalau
    // ada, tapi belum sampai mengunci) tidak boleh terwarisi ke
    // percobaan verifikasi berikutnya, sama seperti `resetAttempts` di
    // `login()`.
    await resetAttempts(mfaLockIdentifier);

    return this.issueTokensForUser(user, deviceContext);
  }

  /**
   * Menerbitkan access+refresh token untuk user yang SUDAH diketahui
   * sah (lolos pengecekan kredensial password ATAU verifikasi OAuth).
   * Method PUBLIK — dipakai `login()` di atas, dan juga
   * `OAuthService` (modul yang sama) setelah berhasil memverifikasi
   * identitas lewat Google/GitHub, supaya kedua jalur login berujung
   * ke satu-satunya tempat yang menerbitkan token, bukan implementasi
   * kedua yang bisa menyimpang (mis. lupa menyimpan refresh token).
   */
  async issueTokensForUser(
    user: {
      id: string;
      email: string;
      name: string;
      role: RoleName;
      createdAt: Date;
    },
    deviceContext?: DeviceContext
  ): Promise<AuthResponseDto> {
    const accessToken = jwtHelper.sign({ id: user.id, email: user.email, role: user.role });
    // Dicek SEBELUM `issueRefreshToken` membuat baris baru — kalau
    // dicek SESUDAHNYA, baris yang baru saja dibuat akan ikut
    // cocok dengan device+IP saat ini dan device ini tidak akan
    // pernah terdeteksi "belum dikenal".
    const isSuspicious = await this.isNewDeviceForExistingUser(user.id, deviceContext);
    // `familyId` TIDAK dioper — login baru selalu memulai family baru
    // (lihat `issueRefreshToken`), berbeda dari rotasi di `refresh()`
    // yang meneruskan family milik token lama.
    const refreshToken = await this.issueRefreshToken(user.id, deviceContext);

    if (isSuspicious) {
      // DI-`await` (bukan fire-and-forget) — supaya email notifikasi
      // dipastikan sudah masuk antrian sebelum response login
      // dikirim. TETAP AMAN untuk alur login utama karena
      // `recordSuspiciousLogin` membungkus SELURUH isinya sendiri
      // dengan try/catch (pola sama seperti `AuditService`, lihat
      // komentar method itu) — errornya di sini TIDAK PERNAH
      // dilempar ulang, jadi tidak bisa membuat login yang sebenarnya
      // sukses berubah jadi gagal di mata user.
      await this.recordSuspiciousLogin(user, deviceContext);
    }

    return {
      accessToken,
      refreshToken,
      user: this.toUserResponseDto(user),
    };
  }

  /**
   * Apakah `deviceContext` saat ini adalah device yang BELUM PERNAH
   * dipakai user ini login sebelumnya. SELALU `false` untuk dua
   * kasus yang sengaja TIDAK dianggap mencurigakan:
   * - `deviceContext` tidak lengkap (userAgent/ipAddress kosong) —
   *   tidak ada dasar valid untuk membandingkan device, memaksakan
   *   deteksi di sini hanya akan menghasilkan false positive.
   * - Ini login PERTAMA user ini sepanjang riwayat akun — belum ada
   *   device "dikenal" untuk dibandingkan sama sekali, jadi "device
   *   belum dikenal" tidak bermakna apa-apa di titik ini.
   */
  private async isNewDeviceForExistingUser(
    userId: string,
    deviceContext?: DeviceContext
  ): Promise<boolean> {
    if (!deviceContext?.userAgent || !deviceContext?.ipAddress) {
      return false;
    }

    const priorSessionCount = await this.authRepository.countRefreshTokensForUser(userId);
    if (priorSessionCount === 0) {
      return false;
    }

    const knownDevice = await this.authRepository.hasKnownDevice(
      userId,
      deviceContext.userAgent,
      deviceContext.ipAddress
    );
    return !knownDevice;
  }

  /**
   * Efek samping dari login yang terdeteksi berasal dari device baru
   * — mencatat audit log DAN mengirim notifikasi email ke pemilik
   * akun. Pola try/catch-lalu-warn yang SAMA dengan `AuditService`
   * (lihat komentar kelas itu): kegagalan di sini TIDAK PERNAH boleh
   * mempengaruhi response login yang sudah terlanjur sukses dikirim
   * ke client.
   */
  private async recordSuspiciousLogin(
    user: { id: string; email: string },
    deviceContext?: DeviceContext
  ): Promise<void> {
    try {
      await this.auditService.logSuspiciousLogin({
        userId: user.id,
        ipAddress: deviceContext?.ipAddress ?? null,
        userAgent: deviceContext?.userAgent ?? null,
      });

      const { deviceName } = parseUserAgent(deviceContext?.userAgent ?? null);
      await enqueueEmailJob({
        type: 'suspicious-login',
        to: user.email,
        deviceName,
        ipAddress: deviceContext?.ipAddress ?? null,
      });
    } catch (error) {
      logger.warn(
        { err: error, userId: user.id },
        'AuthService: gagal mencatat/mengirim notifikasi suspicious login — login utama tetap dianggap sukses'
      );
    }
  }

  /**
   * Menukar refresh token yang valid dengan pasangan token baru
   * (access + refresh) — DENGAN ROTASI: refresh token lama langsung
   * di-revoke begitu dipakai, tidak bisa dipakai ulang.
   *
   * Deteksi pencurian token (reuse detection): jika refresh token yang
   * SUDAH di-revoke dicoba dipakai lagi, itu indikasi kuat token telah
   * dicuri dan dipakai pihak lain setelah pemilik asli me-refresh —
   * responsnya adalah mencabut SELURUH sesi aktif user tersebut,
   * memaksa re-login di semua device.
   */
  async refresh(dto: RefreshDto, deviceContext?: DeviceContext): Promise<RefreshResponseDto> {
    const tokenHash = hashRefreshToken(dto.refreshToken);
    const storedToken = await this.authRepository.findRefreshTokenByHash(tokenHash);

    if (!storedToken) {
      throw new UnauthorizedError('Refresh token tidak valid');
    }

    if (storedToken.revokedAt) {
      // Reuse terdeteksi — cabut seluruh RANGKAIAN (family) token ini
      // saja (Phase 9 upgrade), bukan seluruh sesi user di semua
      // device (lihat catatan `familyId` di skema Prisma untuk alasan
      // perubahan ini dari perilaku sebelumnya).
      await this.authRepository.revokeRefreshTokenFamily(storedToken.familyId);
      throw new UnauthorizedError('Refresh token sudah tidak berlaku. Silakan login ulang.');
    }

    if (storedToken.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token sudah kedaluwarsa. Silakan login ulang.');
    }

    // Finding #20 — batas absolut SATU family (lihat komentar
    // `ABSOLUTE_SESSION_MAX_MS` & `familySessionExpiresAt` di
    // schema.prisma). Ini SENGAJA dicek terpisah dari `expiresAt` di
    // atas: family ini bisa saja masih dalam window `expiresAt`
    // per-baris yang baru (karena terus dipakai/rotasi), tapi sudah
    // melewati umur maksimum sejak login pertama — dianggap sudah
    // "usang" terlepas seberapa aktif dipakai, family langsung dicabut
    // seluruhnya (bukan cuma baris ini) supaya user benar-benar
    // dipaksa login ulang, bukan sekadar rotasi lagi.
    if (storedToken.familySessionExpiresAt < new Date()) {
      await this.authRepository.revokeRefreshTokenFamily(storedToken.familyId);
      throw new UnauthorizedError('Sesi sudah melewati batas maksimum. Silakan login ulang.');
    }

    const user = await this.userRepository.findById(storedToken.userId);
    if (!user) {
      // User sudah terhapus tapi refresh token-nya masih ada di DB —
      // seharusnya tidak terjadi berkat onDelete: Cascade, tapi tetap
      // ditangani secara eksplisit demi keamanan.
      throw new UnauthorizedError('Refresh token tidak valid');
    }

    // Rotasi: cabut token lama SEBELUM menerbitkan yang baru.
    //
    // Finding #19 — `revokeRefreshTokenIfActive` (ATOMIC, bukan
    // `revokeRefreshToken` biasa) dipakai KHUSUS di sini karena ini
    // satu-satunya jalur yang rawan race condition: kalau method ini
    // mengembalikan `false`, artinya baris ini SUDAH direvoke oleh
    // request LAIN di antara pembacaan `storedToken` di atas dan
    // baris ini — persis skenario reuse (dua request bersamaan
    // memakai refresh token yang sama), ditangani IDENTIK dengan
    // reuse biasa: cabut seluruh family, tolak permintaan ini.
    const stillActive = await this.authRepository.revokeRefreshTokenIfActive(storedToken.id);
    if (!stillActive) {
      await this.authRepository.revokeRefreshTokenFamily(storedToken.familyId);
      throw new UnauthorizedError('Refresh token sudah tidak berlaku. Silakan login ulang.');
    }

    const accessToken = jwtHelper.sign({ id: user.id, email: user.email, role: user.role });
    // Family ID DITERUSKAN dari token lama — baris baru ini tetap
    // dianggap "sesi/device yang sama" secara logis, hanya berganti
    // baris fisik karena rotasi.
    const newRefreshToken = await this.issueRefreshToken(
      user.id,
      deviceContext,
      storedToken.familyId,
      // Finding #20 — diteruskan APA ADANYA, TIDAK di-reset — lihat
      // komentar `issueRefreshToken` & `familySessionExpiresAt`.
      storedToken.familySessionExpiresAt
    );

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * Logout — mencabut SATU sesi (refresh token) tertentu, DAN
   * memblacklist access token yang sedang dipakai (`jti`/`exp` dari
   * `req.user`, hasil decode token itu sendiri di `authMiddleware`)
   * supaya token itu langsung tidak berlaku, bukan menunggu sampai
   * kedaluwarsa alami. `userId` dipakai untuk memastikan user hanya
   * bisa logout dari sesinya sendiri, bukan sesi milik user lain.
   */
  async logout(
    userId: string,
    accessTokenJti: string,
    accessTokenExp: number,
    refreshToken: string
  ): Promise<void> {
    await tokenBlacklist.add({
      jti: accessTokenJti,
      userId,
      expiresAt: new Date(accessTokenExp * 1000),
    });

    const tokenHash = hashRefreshToken(refreshToken);
    const storedToken = await this.authRepository.findRefreshTokenByHash(tokenHash);

    if (!storedToken || storedToken.userId !== userId) {
      // Diam-diam sukses (tidak melempar error) — refresh token yang
      // tidak valid/bukan milik user ini secara efektif memang sudah
      // "logged out", tidak ada informasi tambahan yang perlu dibocorkan.
      return;
    }

    if (!storedToken.revokedAt) {
      await this.authRepository.revokeRefreshToken(storedToken.id);
    }
  }

  /**
   * Daftar sesi/device yang MASIH AKTIF milik user — Phase 7 "session
   * management". `currentRefreshToken` (token mentah yang SEDANG
   * dipakai membuat request ini, kalau klien mengirimkannya) dipakai
   * HANYA untuk menandai `isCurrent`, TIDAK memfilter apa pun — sesi
   * dari device lain harus tetap terlihat, itulah tujuan endpoint ini.
   */
  async listSessions(userId: string, currentRefreshToken?: string): Promise<SessionDto[]> {
    const currentTokenHash = currentRefreshToken ? hashRefreshToken(currentRefreshToken) : null;
    const sessions = await this.authRepository.findActiveSessionsForUser(userId);

    return sessions.map((session) => {
      const { browser, operatingSystem, deviceName } = parseUserAgent(session.userAgent);

      return {
        id: session.id,
        userAgent: session.userAgent,
        browser,
        operatingSystem,
        deviceName,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt,
        // Lihat catatan `lastActive` di `SessionDto` (auth.dto.ts) —
        // dihitung ulang dari `createdAt` baris AKTIF saat ini, bukan
        // kolom tersimpan terpisah.
        lastActive: session.createdAt,
        expiresAt: session.expiresAt,
        isCurrent: session.tokenHash === currentTokenHash,
      };
    });
  }

  /**
   * Mencabut SATU sesi/device tertentu milik user — dipakai untuk
   * kasus "logout dari device lain yang hilang/dicuri" tanpa perlu
   * refresh token device tersebut di tangan (beda dari `logout()` di
   * atas, yang butuh refresh token sesi yang MEMANG sedang dipakai).
   *
   * Kepemilikan (`session.userId === userId`) WAJIB diverifikasi —
   * tanpa ini, user A bisa mencabut sesi user B lain hanya dengan
   * menebak/mengetahui ID sesi (UUID, jadi sulit ditebak, tapi tetap
   * bukan alasan untuk tidak memverifikasi kepemilikan secara
   * eksplisit). `NotFoundError` (bukan `ForbiddenError`) dipakai untuk
   * sesi yang bukan milik user ini — mencegah membocorkan informasi
   * "ID ini sungguhan ada, cuma bukan milikmu" ke user yang mencoba
   * menebak-nebak ID sesi orang lain.
   */
  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.authRepository.findRefreshTokenById(sessionId);

    if (!session || session.userId !== userId) {
      throw new NotFoundError('Sesi tidak ditemukan');
    }

    if (!session.revokedAt) {
      await this.authRepository.revokeRefreshToken(session.id);
    }
  }

  /**
   * Mencabut SELURUH sesi aktif user — "Logout All Devices" (Phase 6
   * upgrade). Beda dari reuse-detection di `refresh()` (yang sengaja
   * DIPERSEMPIT ke satu family saja): ini aksi eksplisit user sendiri
   * yang MEMANG menghendaki seluruh device-nya logout, jadi tetap
   * memakai `revokeAllRefreshTokensForUser`, bukan family tunggal.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.authRepository.revokeAllRefreshTokensForUser(userId);
  }

  /**
   * Menandai email user sebagai terverifikasi. Token single-use —
   * dihapus setelah dipakai, jadi tidak bisa dipakai dua kali.
   */
  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    const tokenHash = hashSecureToken(dto.token);
    const storedToken = await this.authRepository.findEmailVerificationTokenByHash(tokenHash);

    if (!storedToken || storedToken.expiresAt < new Date()) {
      throw new UnauthorizedError('Token verifikasi tidak valid atau sudah kedaluwarsa');
    }

    // `update` User + `delete` token dibungkus SATU transaksi
    // (Phase 8) — tanpa ini, ada celah nyata: proses bisa crash tepat
    // di antara keduanya, membuat email SUDAH tercatat terverifikasi
    // tapi token verifikasinya tetap ada di database (bisa terulang
    // dipakai lagi selama belum expired, meski tidak berefek apa-apa
    // lagi — tetap sampah data yang seharusnya tidak mungkin terjadi).
    await this.authRepository.runInTransaction(async (tx) => {
      await this.userRepository.update(storedToken.userId, { emailVerifiedAt: new Date() }, tx);
      await this.authRepository.deleteEmailVerificationToken(storedToken.id, tx);
    });
    await invalidateCache(cacheKeys.userProfile(storedToken.userId));
  }

  /**
   * Selalu resolve tanpa error, TERLEPAS dari apakah email terdaftar
   * atau tidak — pola yang sama seperti pesan error login yang
   * disamakan, mencegah *user enumeration* (penyerang tidak bisa
   * memakai endpoint ini untuk mengecek email mana yang punya akun).
   */
  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.userRepository.findByEmail(dto.email);
    if (!user) {
      return;
    }

    // Setiap permintaan baru menggantikan token lama — mencegah
    // beberapa link reset valid sekaligus.
    await this.authRepository.deleteAllPasswordResetTokensForUser(user.id);

    const rawToken = generateSecureToken();
    await this.authRepository.createPasswordResetToken({
      tokenHash: hashSecureToken(rawToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });

    await enqueueEmailJob({ type: 'password-reset', to: user.email, token: rawToken });
  }

  /**
   * Reset password DAN mencabut seluruh sesi aktif (refresh token)
   * user tersebut — kalau password lama sudah bocor, sesi lama yang
   * mungkin sudah dipegang penyerang juga harus ikut mati, bukan
   * cuma password-nya yang berganti.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = hashSecureToken(dto.token);
    const storedToken = await this.authRepository.findPasswordResetTokenByHash(tokenHash);

    if (!storedToken || storedToken.expiresAt < new Date()) {
      throw new UnauthorizedError('Token reset password tidak valid atau sudah kedaluwarsa');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, env.BCRYPT_SALT_ROUNDS);

    // Ketiga perubahan ini WAJIB atomik (Phase 8): ganti password,
    // hapus token reset (single-use), DAN cabut seluruh sesi aktif
    // (memaksa re-login di semua device demi keamanan). Tanpa
    // transaksi, proses yang crash di tengah bisa meninggalkan salah
    // satu kombinasi paling berbahaya: password sudah berganti TAPI
    // sesi lama (termasuk milik penyerang, kalau reset ini dipicu
    // karena akun dibajak) tetap valid — persis skenario yang harusnya
    // dicegah oleh reset password.
    await this.authRepository.runInTransaction(async (tx) => {
      await this.userRepository.update(storedToken.userId, { password: hashedPassword }, tx);
      await this.authRepository.deletePasswordResetToken(storedToken.id, tx);
      await this.authRepository.revokeAllRefreshTokensForUser(storedToken.userId, tx);
    });
    await invalidateCache(cacheKeys.userProfile(storedToken.userId));
  }

  private async issueRefreshToken(
    userId: string,
    deviceContext?: DeviceContext,
    familyId?: string,
    // Finding #20 — WAJIB diteruskan APA ADANYA saat rotasi (dari
    // `storedToken.familySessionExpiresAt` di `refresh()`); hanya
    // dihitung baru (`Date.now() + ABSOLUTE_SESSION_MAX_MS`) saat
    // family BARU dimulai (login/OAuth), sama seperti `familyId`.
    familySessionExpiresAt?: Date
  ): Promise<string> {
    const rawToken = generateRefreshToken();

    await this.authRepository.createRefreshToken({
      tokenHash: hashRefreshToken(rawToken),
      userId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      // Tidak diteruskan (login/OAuth baru) → family baru dimulai di
      // sini. Diteruskan (rotasi lewat `refresh()`) → tetap rangkaian
      // yang sama. Lihat catatan `familyId` di skema Prisma.
      familyId: familyId ?? randomUUID(),
      familySessionExpiresAt:
        familySessionExpiresAt ?? new Date(Date.now() + ABSOLUTE_SESSION_MAX_MS),
      userAgent: deviceContext?.userAgent ?? null,
      ipAddress: deviceContext?.ipAddress ?? null,
    });

    return rawToken;
  }

  private async issueEmailVerificationToken(userId: string, email: string): Promise<void> {
    const rawToken = generateSecureToken();

    await this.authRepository.createEmailVerificationToken({
      tokenHash: hashSecureToken(rawToken),
      userId,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });

    await enqueueEmailJob({ type: 'verification', to: email, token: rawToken });
  }

  private toUserResponseDto(user: {
    id: string;
    email: string;
    name: string;
    createdAt: Date;
  }): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    };
  }
}
