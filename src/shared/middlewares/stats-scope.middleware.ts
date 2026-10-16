import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { UserRepository } from '../../modules/users/user.repository';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error';
import { getTenantContext } from '../tenant/tenant-context';

// Instance module-level, pola sama dengan `auth.middleware.ts`.
const userRepository = new UserRepository(prisma);

/**
 * R21 — dipasang SETELAH `authMiddleware` dan `requirePermission('dashboard.read')` di rute statistik.
 *
 *  - Ada header tenant: lolos. Ikatan header ke identitas SUDAH ditegakkan `authMiddleware` (S1): user bertenant hanya
 *    boleh memilih tenantnya sendiri, hanya ADMIN tanpa tenant yang boleh memilih tenant mana pun.
 *  - Tanpa header (mode PLATFORM, angka global lintas tenant): hanya ADMIN yang tidak terikat tenant manapun. User
 *    dibaca dari database (bukan klaim token) supaya perubahan tenant/role langsung berlaku. Request lewat API key
 *    TIDAK dianggap platform: key bisa terikat tenant (`ApiKey.tenantId`) yang tidak terlihat di sini, jadi fail-closed.
 */
export async function requireTenantOrPlatformAdmin(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    if (getTenantContext().tenantId != null) {
      next();
      return;
    }
    if (req.user.apiKeyScopes) {
      throw new ForbiddenError(
        'Tanpa header X-Tenant-ID, statistik ini hanya untuk admin platform'
      );
    }
    const owner = await userRepository.findById(req.user.id);
    if (!owner || owner.tenantId != null || owner.role !== 'ADMIN') {
      throw new ForbiddenError(
        'Tanpa header X-Tenant-ID, statistik ini hanya untuk admin platform'
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}
