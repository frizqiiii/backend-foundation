import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { UserRepository } from '../users/user.repository';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { OAuthService } from './oauth.service';
import { AuthController } from './auth.controller';
import { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ActivityRepository } from '../activity/activity.repository';
import { ActivityService } from '../activity/activity.service';
import { MfaRepository } from './mfa.repository';
import { MfaService } from './mfa.service';
import { MfaController } from './mfa.controller';
import { TenantRepository } from '../tenants/tenant.repository';
import { SsoConnectionRepository, SsoIdentityRepository } from './sso.repository';
import { SsoConnectionService, SsoService } from './sso.service';
import { SsoAdminController, SsoController } from './sso.controller';

/**
 * Composition root untuk modul `auth`.
 * `UserRepository` di sini adalah INSTANCE YANG SAMA jenisnya dengan
 * yang dipakai `modules/users/user.routes.ts` (kelasnya di-import
 * dari sana), bukan instance bersama — Prisma Client-lah (singleton
 * di `shared/config/database.ts`) yang menjamin keduanya bicara ke
 * database yang sama secara konsisten.
 *
 * `AuditRepository`/`ActivityRepository` (Phase 5) di-instantiate LAGI
 * di sini, bukan di-import sebagai singleton dari modulnya masing-
 * masing — konsisten dengan pola composition-root manual yang dipakai
 * di seluruh aplikasi ini (lihat `event.routes.ts`, dst): setiap
 * modul membangun graph dependency-nya sendiri, terhubung lewat
 * Prisma Client yang sama.
 */
const userRepository = new UserRepository(prisma);
const authRepository = new AuthRepository(prisma);
// `auditService` dipindah ke atas `authService` (beda dari urutan
// sebelumnya) — `AuthService` sekarang bergantung padanya untuk
// mencatat percobaan login yang gagal (Phase 1 upgrade).
const auditService = new AuditService(new AuditRepository(prisma));
// Phase 12 — `MfaService` dibuat SEBELUM `authService` karena
// `AuthService` sekarang bergantung padanya untuk menyelesaikan login
// user yang MFA-nya aktif.
const mfaService = new MfaService(new MfaRepository(prisma));
const authService = new AuthService(userRepository, authRepository, auditService, mfaService);
const oauthService = new OAuthService(userRepository, authRepository, authService);
const activityService = new ActivityService(new ActivityRepository(prisma));
const authController = new AuthController(authService, oauthService, auditService, activityService);
const mfaController = new MfaController(mfaService, userRepository);

// Fase 2 (Enterprise SSO) — `TenantRepository` di-instantiate LAGI di
// sini (bukan diimpor dari `modules/tenants/tenant.routes.ts`),
// konsisten dengan pola composition-root manual yang sudah dipakai
// di seluruh file ini (lihat komentar di atas soal `AuditRepository`/
// `ActivityRepository`).
const tenantRepository = new TenantRepository(prisma);
const ssoConnectionRepository = new SsoConnectionRepository(prisma);
const ssoIdentityRepository = new SsoIdentityRepository(prisma);
const ssoConnectionService = new SsoConnectionService(ssoConnectionRepository, tenantRepository);
const ssoService = new SsoService(
  ssoConnectionRepository,
  ssoIdentityRepository,
  tenantRepository,
  userRepository,
  authService
);
const ssoAdminController = new SsoAdminController(ssoConnectionService);
const ssoController = new SsoController(ssoService);

export const authRouter = Router();

// Rute publik.
authRouter.post('/register', asyncHandler(authController.register));
authRouter.post('/login', asyncHandler(authController.login));
authRouter.post('/refresh', asyncHandler(authController.refresh));
authRouter.post('/verify-email', asyncHandler(authController.verifyEmail));
authRouter.post('/forgot-password', asyncHandler(authController.forgotPassword));
authRouter.post('/reset-password', asyncHandler(authController.resetPassword));
authRouter.post('/oauth/google', asyncHandler(authController.loginWithGoogle));
authRouter.post('/oauth/github', asyncHandler(authController.loginWithGithub));
// Phase 12 — publik SECARA SENGAJA (bukan `authMiddleware`): titik ini
// terjadi SEBELUM user punya access token sama sekali (lihat
// `AuthService.login`) — otorisasinya adalah kepemilikan
// `challengeToken` yang valid & belum kedaluwarsa, bukan sesi yang
// sudah login, persis pola yang sama dengan `/auth/refresh` di atas.
authRouter.post('/mfa/verify-login', asyncHandler(authController.verifyMfaLogin));

// Rute terproteksi — butuh access token valid untuk menentukan siapa
// yang logout (lihat AuthController.logout).
authRouter.post('/logout', authMiddleware, asyncHandler(authController.logout));

// Phase 12 — pengaturan MFA akun SENDIRI (`req.user.id`), tidak ada
// permission khusus di luar sekadar sudah login, sama pola dengan
// `/sessions` di bawah.
authRouter.post('/mfa/setup', authMiddleware, asyncHandler(mfaController.setup));
authRouter.post('/mfa/confirm', authMiddleware, asyncHandler(mfaController.confirm));
authRouter.post('/mfa/disable', authMiddleware, asyncHandler(mfaController.disable));

// Phase 7 — session management & login history, semuanya beroperasi
// pada milik SENDIRI (`req.user.id`), tidak butuh permission khusus
// di luar sekadar sudah login.
authRouter.get('/sessions', authMiddleware, asyncHandler(authController.listSessions));
authRouter.delete('/sessions/:id', authMiddleware, asyncHandler(authController.revokeSession));
// Phase 6 upgrade — "Logout All Devices". Didaftarkan SETELAH
// `/sessions/:id` (urutan tidak masalah di Express untuk method
// berbeda seperti ini, tapi tetap dikelompokkan berdekatan untuk
// keterbacaan: keduanya sama-sama varian "cabut sesi").
authRouter.delete('/sessions', authMiddleware, asyncHandler(authController.revokeAllSessions));
authRouter.get('/login-history', authMiddleware, asyncHandler(authController.loginHistory));

// Phase 9 upgrade — admin melihat riwayat login user LAIN. Ditaruh di
// bawah prefix `/admin/` (bukan sekadar `requirePermission` di rute
// `/login-history` yang sama) supaya endpoint diri-sendiri vs
// endpoint admin tetap dua URL yang jelas berbeda secara eksplisit,
// bukan satu URL yang perilakunya diam-diam berubah tergantung role.
authRouter.get(
  '/admin/users/:id/login-history',
  authMiddleware,
  requirePermission('audit.read'),
  asyncHandler(authController.loginHistoryForUser)
);

// Fase 2 (Enterprise SSO) — endpoint admin (konfigurasi) di bawah
// `sso.manage`, endpoint alur login (redirect + consume) SENGAJA
// PUBLIK — lihat komentar lengkap di `SsoController`.
authRouter.put(
  '/admin/sso/:tenantSlug',
  authMiddleware,
  requirePermission('sso.manage'),
  asyncHandler(ssoAdminController.upsert)
);
authRouter.get(
  '/admin/sso/:tenantSlug',
  authMiddleware,
  requirePermission('sso.manage'),
  asyncHandler(ssoAdminController.get)
);
authRouter.get('/sso/:tenantSlug/login', asyncHandler(ssoController.login));
authRouter.get('/sso/:tenantSlug/callback', asyncHandler(ssoController.callback));
authRouter.post('/sso/consume', asyncHandler(ssoController.consume));
