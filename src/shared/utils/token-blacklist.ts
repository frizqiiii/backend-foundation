import { prisma } from '../config/database';

/**
 * Daftar hitam access token — utility di `shared/` (BUKAN di dalam
 * `modules/auth/auth.repository.ts`) karena dipakai dari dua arah
 * yang berbeda lapisan: `shared/middlewares/auth.middleware.ts` (baca)
 * dan `modules/auth/auth.service.ts` (tulis, saat logout). Kalau
 * logic ini ditaruh di `AuthRepository`, `shared/` (yang seharusnya
 * di-*depend upon*, bukan men-*depend* ke `modules/`) akan terpaksa
 * mengimpor dari `modules/auth/` — arah dependensi yang salah.
 */
export const tokenBlacklist = {
  async isBlacklisted(jti: string): Promise<boolean> {
    const entry = await prisma.blacklistedToken.findUnique({ where: { jti } });
    return entry !== null;
  },

  async add(params: { jti: string; userId: string; expiresAt: Date }): Promise<void> {
    await prisma.blacklistedToken.create({ data: params });
  },
};
