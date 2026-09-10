import type { Request, Response, NextFunction } from 'express';
import type { RoleName } from '../types/role';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error';

/**
 * Middleware RBAC — dipasang SETELAH `authMiddleware` di rute yang
 * ingin dibatasi ke role tertentu, misal:
 *
 *   router.delete('/:id', authMiddleware, requireRole('ADMIN'), ...)
 *
 * Menerima satu atau lebih role yang diizinkan (OR — cukup salah satu
 * cocok). Tidak melakukan query database sama sekali — hanya membaca
 * `req.user.role` yang sudah ditempelkan `authMiddleware` dari payload
 * JWT (lihat catatan trade-off "role baru berlaku setelah re-login"
 * di `shared/utils/jwt.ts`).
 */
export function requireRole(...allowedRoles: RoleName[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      // Safety-net: seharusnya tidak pernah tercapai jika middleware
      // dipasang dengan urutan yang benar (authMiddleware lebih dulu).
      throw new UnauthorizedError();
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw new ForbiddenError(`Aksi ini hanya untuk role: ${allowedRoles.join(', ')}`);
    }

    next();
  };
}
