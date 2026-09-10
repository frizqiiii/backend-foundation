import type { Request, Response, NextFunction } from 'express';
import type { Permission } from '../security/permissions';
import { hasPermission } from '../security/permissions';
import { ForbiddenError, UnauthorizedError } from '../utils/http-error';

/**
 * Middleware otorisasi berbasis Permission — pasangan `requireRole`
 * (`role.middleware.ts`) untuk kasus yang butuh presisi lebih halus
 * dari sekadar "role apa". Dipasang SETELAH `authMiddleware`, sama
 * seperti `requireRole`.
 *
 * Keduanya (`requireRole` dan `requirePermission`) TETAP hidup
 * berdampingan — TIDAK semua otorisasi butuh presisi permission;
 * kasus biner sederhana ("hanya ADMIN yang boleh...") tetap sah pakai
 * `requireRole` langsung. `requirePermission` dipakai ketika aturannya
 * benar-benar tentang KAPABILITAS (mis. "siapa pun yang punya izin
 * `event.delete`"), bukan identitas role itu sendiri.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    if (!hasPermission(req.user.role, permission)) {
      throw new ForbiddenError(`Aksi ini membutuhkan permission: ${permission}`);
    }

    // Phase 12 — request yang diautentikasi lewat API key membawa
    // `apiKeyScopes`. Permission WAJIB ada di KEDUANYA: permission role
    // pemiliknya (dicek di atas — role bisa saja sudah diturunkan
    // SETELAH key dibuat) DAN scope key itu sendiri (key sengaja
    // dibuat lebih sempit dari permission pemiliknya). Salah satu
    // tidak cukup, dan tidak ada gunanya membedakan dua error ini
    // dengan pesan berbeda — dari sudut pandang pemanggil API,
    // keduanya sama-sama "key ini tidak boleh melakukan aksi ini".
    if (req.user.apiKeyScopes && !req.user.apiKeyScopes.includes(permission)) {
      throw new ForbiddenError(`API key ini tidak memiliki scope: ${permission}`);
    }

    next();
  };
}
