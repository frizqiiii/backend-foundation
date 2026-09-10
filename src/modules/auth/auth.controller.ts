import type { Request, Response } from 'express';
import type { AuthService } from './auth.service';
import type { OAuthService } from './oauth.service';
import type { AuditService } from '../audit/audit.service';
import type { ActivityService } from '../activity/activity.service';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  googleLoginSchema,
  githubLoginSchema,
  paginationQuerySchema,
} from './auth.dto';
import { verifyMfaLoginSchema } from './mfa.dto';
import { UnauthorizedError } from '../../shared/utils/http-error';
import { sendSuccess } from '../../shared/utils/response';
import { getClientIp, getUserAgent } from '../../shared/utils/request-context';

/**
 * Controller Layer — HANYA HTTP concerns, pola yang sama seperti
 * `UserController`/`ProductController`.
 */
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oauthService: OAuthService,
    private readonly auditService: AuditService,
    private readonly activityService: ActivityService
  ) {}

  register = async (req: Request, res: Response): Promise<void> => {
    const input = registerSchema.parse(req.body);
    const user = await this.authService.register(input);

    sendSuccess(res, 201, 'Registrasi berhasil. Cek email untuk verifikasi akun.', user);
  };

  /**
   * Audit/activity dicatat SETELAH `authService.login` sukses — kalau
   * kredensial salah, `authService.login` sudah melempar error lebih
   * dulu (baris di bawah tidak pernah tercapai), jadi otomatis TIDAK
   * ada audit "LOGIN" palsu untuk percobaan login yang gagal.
   *
   * Phase 12 — `authService.login` sekarang bisa mengembalikan
   * `MfaRequiredResponseDto` (`{ mfaRequired: true, challengeToken }`)
   * untuk user dengan MFA aktif. Cabang ini SENGAJA TIDAK mencatat
   * audit/activity "LOGIN" — password benar tapi login belum selesai,
   * audit LOGIN yang sesungguhnya baru dicatat di `verifyMfaLogin` di
   * bawah begitu langkah kedua juga berhasil.
   */
  login = async (req: Request, res: Response): Promise<void> => {
    const input = loginSchema.parse(req.body);
    const deviceContext = { ipAddress: getClientIp(req), userAgent: getUserAgent(req) };
    const result = await this.authService.login(input, deviceContext);

    if ('mfaRequired' in result) {
      sendSuccess(res, 200, 'Verifikasi MFA diperlukan untuk menyelesaikan login', result);
      return;
    }

    const actor = { userId: result.user.id, ...deviceContext };
    await this.auditService.logLogin(actor);
    await this.activityService.logAuthActivity(`User ${result.user.email} berhasil login`, actor);

    sendSuccess(res, 200, 'Login berhasil', result);
  };

  /**
   * Langkah kedua login untuk user dengan MFA aktif — lihat
   * `AuthService.verifyMfaLogin`. Audit/activity "LOGIN" dicatat DI
   * SINI (bukan di `login` di atas), karena inilah titik login
   * SUNGGUHAN selesai untuk user ber-MFA.
   */
  verifyMfaLogin = async (req: Request, res: Response): Promise<void> => {
    const input = verifyMfaLoginSchema.parse(req.body);
    const deviceContext = { ipAddress: getClientIp(req), userAgent: getUserAgent(req) };
    const result = await this.authService.verifyMfaLogin(input, deviceContext);

    const actor = { userId: result.user.id, ...deviceContext };
    await this.auditService.logLogin(actor);
    await this.activityService.logAuthActivity(`User ${result.user.email} berhasil login`, actor);

    sendSuccess(res, 200, 'Login berhasil', result);
  };

  /**
   * Endpoint publik (TIDAK dipasang `authMiddleware`) — yang
   * membuktikan hak akses di sini adalah kepemilikan refresh token
   * yang valid, bukan access token (yang mungkin sudah kedaluwarsa;
   * itulah justru alasan endpoint ini ada).
   */
  refresh = async (req: Request, res: Response): Promise<void> => {
    const input = refreshSchema.parse(req.body);
    const deviceContext = { ipAddress: getClientIp(req), userAgent: getUserAgent(req) };
    const result = await this.authService.refresh(input, deviceContext);

    sendSuccess(res, 200, 'Token berhasil diperbarui', result);
  };

  /**
   * Endpoint terproteksi — butuh access token valid (memastikan
   * permintaan logout datang dari sesi yang memang sedang aktif) DAN
   * refresh token di body (menentukan sesi mana yang dicabut).
   * `req.user.jti`/`exp` (hasil decode access token oleh
   * `authMiddleware`) dipakai untuk memblacklist access token ini
   * juga — lihat `AuthService.logout`.
   */
  logout = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const input = logoutSchema.parse(req.body);
    await this.authService.logout(req.user.id, req.user.jti, req.user.exp, input.refreshToken);

    const actor = {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    };
    await this.auditService.logLogout(actor);
    await this.activityService.logAuthActivity('User logout', actor);

    sendSuccess(res, 200, 'Logout berhasil', null);
  };

  /**
   * `GET /auth/sessions` — daftar device/sesi yang sedang aktif milik
   * user yang login. Body request TIDAK berisi refresh token (beda
   * dari `logout`), jadi `isCurrent` di Service hanya bisa ditandai
   * kalau klien MEMILIH mengirim refresh token sesi saat ini lewat
   * query string opsional `?currentRefreshToken=...` — kalau tidak
   * dikirim, seluruh sesi tetap tampil, hanya tanpa penanda `isCurrent`.
   */
  listSessions = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const currentRefreshToken =
      typeof req.query.currentRefreshToken === 'string' ? req.query.currentRefreshToken : undefined;
    const sessions = await this.authService.listSessions(req.user.id, currentRefreshToken);

    sendSuccess(res, 200, 'Daftar sesi berhasil diambil', sessions);
  };

  /**
   * `DELETE /auth/sessions/:id` — mencabut satu sesi/device tertentu
   * (mis. device lain yang hilang/dicuri), tanpa perlu refresh token
   * device tersebut di tangan. Kepemilikan ditegakkan di
   * `AuthService.revokeSession`.
   */
  revokeSession = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.authService.revokeSession(req.user.id, req.params.id);

    const actor = {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    };
    await this.auditService.logSessionRevoked(req.params.id, actor);

    sendSuccess(res, 200, 'Sesi berhasil dicabut', null);
  };

  /**
   * `DELETE /auth/sessions` — "Logout All Devices" (Phase 6 upgrade).
   * Berbeda dari `DELETE /auth/sessions/:id` di atas (satu sesi),
   * endpoint ini mencabut SELURUH sesi aktif milik user, TERMASUK
   * sesi yang sedang dipakai membuat request ini sendiri — sesuai
   * makna literal "logout dari semua device". Klien bertanggung jawab
   * menghapus access/refresh token yang tersimpan di sisinya sendiri
   * setelah memanggil ini.
   */
  revokeAllSessions = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    await this.authService.revokeAllSessions(req.user.id);

    const actor = {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: getUserAgent(req),
    };
    await this.auditService.logAllSessionsRevoked(actor);

    sendSuccess(res, 200, 'Seluruh sesi berhasil dicabut', null);
  };

  /**
   * `GET /auth/login-history` — riwayat login/logout milik user
   * sendiri, dibaca dari `AuditLog` (Phase 5) lewat `AuditService`.
   * `page`/`limit` divalidasi Zod (`paginationQuerySchema`), sama
   * seperti pola pagination di modul `events`.
   */
  loginHistory = async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const { page, limit } = paginationQuerySchema.parse(req.query);
    const result = await this.auditService.getLoginHistory(req.user.id, { page, limit });

    sendSuccess(res, 200, 'Riwayat login berhasil diambil', result.data, result.meta);
  };

  /**
   * `GET /auth/admin/users/:id/login-history` (Phase 9 upgrade) —
   * versi ADMIN dari `loginHistory` di atas: melihat riwayat login
   * user LAIN, bukan diri sendiri. Sengaja memakai ULANG
   * `AuditService.getLoginHistory` yang sama persis (method itu sudah
   * menerima `userId` bebas, bukan terikat ke `req.user.id`) —
   * satu-satunya beda adalah SUMBER `userId`-nya (`req.params.id`) dan
   * proteksi `requirePermission('audit.read')` di route.
   */
  loginHistoryForUser = async (req: Request, res: Response): Promise<void> => {
    const { page, limit } = paginationQuerySchema.parse(req.query);
    const result = await this.auditService.getLoginHistory(req.params.id, { page, limit });

    sendSuccess(res, 200, 'Riwayat login user berhasil diambil', result.data, result.meta);
  };

  verifyEmail = async (req: Request, res: Response): Promise<void> => {
    const input = verifyEmailSchema.parse(req.body);
    await this.authService.verifyEmail(input);

    sendSuccess(res, 200, 'Email berhasil diverifikasi', null);
  };

  /**
   * Selalu 200, terlepas dari apakah email terdaftar atau tidak —
   * mengikuti pola generik di `AuthService.forgotPassword` (mencegah
   * user enumeration).
   */
  forgotPassword = async (req: Request, res: Response): Promise<void> => {
    const input = forgotPasswordSchema.parse(req.body);
    await this.authService.forgotPassword(input);

    sendSuccess(res, 200, 'Jika email terdaftar, instruksi reset password telah dikirim', null);
  };

  resetPassword = async (req: Request, res: Response): Promise<void> => {
    const input = resetPasswordSchema.parse(req.body);
    await this.authService.resetPassword(input);

    sendSuccess(res, 200, 'Password berhasil direset. Silakan login ulang.', null);
  };

  /**
   * `idToken` berasal dari Google Identity Services di sisi frontend
   * (mis. Google Sign-In button) — backend tidak pernah melihat
   * password/kredensial Google, hanya memverifikasi token yang sudah
   * ditandatangani Google.
   */
  loginWithGoogle = async (req: Request, res: Response): Promise<void> => {
    const input = googleLoginSchema.parse(req.body);
    const result = await this.oauthService.loginWithGoogle(input.idToken);

    sendSuccess(res, 200, 'Login Google berhasil', result);
  };

  /**
   * `code` berasal dari redirect callback OAuth GitHub di sisi
   * frontend — pertukaran code→access_token dilakukan di sini
   * (server), karena butuh GITHUB_CLIENT_SECRET yang tidak boleh
   * pernah ada di kode frontend.
   */
  loginWithGithub = async (req: Request, res: Response): Promise<void> => {
    const input = githubLoginSchema.parse(req.body);
    const result = await this.oauthService.loginWithGithub(input.code);

    sendSuccess(res, 200, 'Login GitHub berhasil', result);
  };
}
