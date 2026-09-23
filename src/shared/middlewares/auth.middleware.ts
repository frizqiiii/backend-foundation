import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { jwtHelper } from '../utils/jwt';
import { UnauthorizedError, NotFoundError, ForbiddenError } from '../utils/http-error';
import { tokenBlacklist } from '../utils/token-blacklist';
import { prisma } from '../config/database';
import { UserRepository } from '../../modules/users/user.repository';
import { ApiKeyRepository } from '../../modules/api-keys/api-key.repository';
import { ApiKeyService } from '../../modules/api-keys/api-key.service';
import { enforcePartnerApiGatewayLimit } from '../security/api-key-gateway';
import { resolveTenantPlanSafe } from '../tenant/tenant-plan';
import { isTenantActiveForApiKey } from '../tenant/tenant-status';
import { API_KEY_JTI_PREFIX } from '../security/api-key-auth';

// Instance module-level — sama pola & alasan seperti
// `shared/tenant/tenant.middleware.ts`: TIDAK diimpor dari
// `modules/api-keys/api-key.routes.ts` supaya arah dependency tetap
// konsisten (`modules/*` boleh bergantung ke `shared/*`, bukan
// sebaliknya).
const userRepository = new UserRepository(prisma);
const apiKeyService = new ApiKeyService(new ApiKeyRepository(prisma));

/** SETIAP API key aplikasi ini diawali `bfk_` (lihat `KEY_PREFIX` di
 * `api-key.service.ts`) — JWT (format `xxx.yyy.zzz`, base64url) TIDAK
 * PERNAH punya prefix ini, jadi pemeriksaan ini 100% tidak ambigu dan
 * tidak mengubah perilaku untuk SATU PUN client yang sudah memakai
 * JWT sebelum Phase 12. */
const API_KEY_PREFIX = 'bfk_';

/** Unix timestamp (detik) yang jauh di masa depan — dipakai sebagai
 * `exp` placeholder untuk API key TANPA `expiresAt` (key ini valid
 * sampai eksplisit di-revoke, bukan kedaluwarsa alami seperti JWT).
 * NILAI INI TIDAK PERNAH benar-benar dipakai untuk memutuskan
 * kedaluwarsa — `ApiKeyService.authenticate` sudah menegakkan
 * `expiresAt`/`revokedAt` SEBELUM sampai ke sini; field ini murni
 * supaya bentuk `req.user` tetap konsisten dengan yang diisi jalur JWT. */
const NO_EXPIRY_PLACEHOLDER_EXP = Math.floor(Date.now() / 1000) + 100 * 365 * 24 * 60 * 60;

/**
 * Middleware autentikasi — menghadang request ke rute terproteksi.
 *
 * Alur:
 * 1. Baca header `Authorization: Bearer <token>`.
 * 2. Phase 12 — kalau token diawali `bfk_`, delegasikan ke jalur API
 *    key (`authenticateWithApiKey` di bawah) dan BERHENTI DI SITU;
 *    jalur JWT di bawahnya sama sekali tidak tersentuh untuk request
 *    ini.
 * 3. Verifikasi token menggunakan JWT_SECRET.
 * 4. Cek apakah token ini (via `jti`) ada di daftar hitam — mis.
 *    karena user sudah logout sebelum token ini kedaluwarsa secara
 *    alami. Ini SATU-SATUNYA query database yang dilakukan middleware
 *    ini; trade-off sadar antara stateless JWT (cepat, tanpa query)
 *    vs kemampuan mencabut token sebelum expired (butuh query). Untuk
 *    skala lebih besar, cek ini idealnya pindah ke cache in-memory
 *    (Redis) alih-alih query Postgres di setiap request.
 * 5. Jika valid & tidak di-blacklist, tempelkan payload ke `req.user`.
 * 6. Jika tidak valid/kadaluarsa/di-blacklist, lempar
 *    `UnauthorizedError` yang ditangkap oleh global error handler.
 *
 * Middleware ini di-`try/catch` secara eksplisit dan meneruskan error
 * lewat `next(error)` — BUKAN mengandalkan Express menangkap promise
 * rejection otomatis (Express 4 tidak melakukan itu untuk middleware
 * async), sehingga tidak perlu dibungkus `asyncHandler` di rute yang
 * memakainya.
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedError(
        'Token tidak ditemukan. Sertakan header Authorization: Bearer <token>'
      );
    }

    const token = authHeader.slice('Bearer '.length).trim();

    if (token.startsWith(API_KEY_PREFIX)) {
      await authenticateWithApiKey(req, token);
      next();
      return;
    }

    let payload;
    try {
      payload = jwtHelper.verify(token);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError('Token sudah kadaluarsa');
      }
      throw new UnauthorizedError('Token tidak valid');
    }

    const isBlacklisted = await tokenBlacklist.isBlacklisted(payload.jti);
    if (isBlacklisted) {
      throw new UnauthorizedError('Token sudah dicabut (revoked). Silakan login ulang.');
    }

    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role,
      jti: payload.jti,
      exp: payload.exp,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Phase 12 — jalur autentikasi API key. Mengisi `req.user` dengan
 * bentuk yang SAMA seperti jalur JWT (role/email dari User pemilik
 * key, BUKAN dari key itu sendiri — key tidak menyimpan salinan
 * email/role sendiri, hanya `userId`) PLUS `apiKeyScopes`, supaya
 * seluruh Controller/Service existing yang membaca `req.user.role`
 * (mis. pengecekan kepemilikan resource) tetap bekerja tanpa
 * perubahan apa pun — hanya `requirePermission` yang perlu tahu
 * tentang `apiKeyScopes` secara eksplisit (lihat
 * `permission.middleware.ts`).
 */
async function authenticateWithApiKey(req: Request, rawKey: string): Promise<void> {
  const { apiKeyId, userId, tenantId, scopes, expiresAt, rateLimitOverridePerMinute } =
    await apiKeyService.authenticate(rawKey);

  // T3 — WAJIB dicek SEDINI mungkin (sebelum kuota Redis di bawah
  // ikut ditegakkan/dicatat untuk request yang toh akan ditolak).
  // Lihat `shared/tenant/tenant-status.ts` untuk kenapa ini
  // diperlukan (tanpa ini, suspend tenant tidak berlaku sama sekali
  // di jalur API key) dan kenapa SENGAJA fail-closed.
  if (!(await isTenantActiveForApiKey(tenantId))) {
    throw new ForbiddenError('Tenant pemilik API key ini tidak ditemukan atau sedang tidak aktif');
  }

  // Fase 2 (item 2.10 — API Gateway edge) — kuota PER API KEY,
  // ditegakkan SEDINI mungkin (sebelum query `findById` di bawah)
  // supaya request yang sudah pasti ditolak tidak ikut membebani
  // database dengan lookup yang sia-sia.
  //
  // Fase 2 (item 2.11 — rate limit per-tier/plan): kuota-nya sekarang
  // mengikuti plan tenant pemilik key (`resolveTenantPlanSafe` di-
  // cache & fail-soft — tidak menambah query per request, tidak
  // pernah menggagalkan autentikasi).
  // T4: `rateLimitOverridePerMinute` (dari row key yang sama, TANPA
  // query tambahan) MENGALAHKAN tier plan kalau diisi — lihat
  // komentar `enforcePartnerApiGatewayLimit`.
  await enforcePartnerApiGatewayLimit(
    apiKeyId,
    await resolveTenantPlanSafe(tenantId),
    rateLimitOverridePerMinute
  );

  const user = await userRepository.findById(userId);
  if (!user) {
    // Pemilik key sudah dihapus (soft-delete) — key-nya sendiri belum
    // tentu ikut ter-revoke otomatis (lihat catatan "Belum ditegakkan"
    // di docs/security-guide.md), jadi tetap ditolak eksplisit di sini.
    throw new NotFoundError('Pemilik API key ini tidak ditemukan');
  }

  req.user = {
    id: user.id,
    email: user.email,
    role: user.role as never, // Prisma enum Role vs RoleName — sama pola cast yang sudah dipakai di seluruh test fixture (lihat auth.service.spec.ts)
    jti: `${API_KEY_JTI_PREFIX}${apiKeyId}`,
    exp: expiresAt ? Math.floor(expiresAt.getTime() / 1000) : NO_EXPIRY_PLACEHOLDER_EXP,
    apiKeyScopes: scopes,
  };
}
