import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { UserRepository } from './user.repository';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';
import { UploadRepository } from '../upload/upload.repository';
import { PrivacyRepository } from '../privacy/privacy.repository';
import { PrivacyService } from '../privacy/privacy.service';
import { PrivacyController } from '../privacy/privacy.controller';

/**
 * Composition root untuk modul `users`.
 * Catatan konsolidasi (#2 — Auth): `POST /register` dan `POST /login`
 * sudah pindah ke `modules/auth/auth.routes.ts` (`/api/auth/register`,
 * `/api/auth/login`). Modul ini sekarang hanya menyediakan endpoint
 * profil + endpoint admin (list, delete) sebagai contoh pemakaian
 * permission.
 */
const userRepository = new UserRepository(prisma);
const userService = new UserService(userRepository);
const auditService = new AuditService(new AuditRepository(prisma));
const userController = new UserController(userService, auditService);

// Fase 2 (Data retention & GDPR erasure) — lihat `docs/data-retention-policy.md`.
const privacyRepository = new PrivacyRepository(prisma);
const uploadRepository = new UploadRepository(prisma);
const privacyService = new PrivacyService(privacyRepository, userRepository, uploadRepository);
const privacyController = new PrivacyController(privacyService);

export const userRouter = Router();

// Rute terproteksi — `authMiddleware` dijalankan lebih dulu; jika
// token tidak valid, request tidak akan pernah sampai ke controller.
userRouter.get('/me', authMiddleware, asyncHandler(userController.me));

// Contoh penerapan Phase 7 permission system (persis contoh di
// spesifikasi: "ADMIN: user.manage") — sebelumnya
// `requireRole('ADMIN')`. Hasilnya ekuivalen (hanya ADMIN yang punya
// `user.manage` saat ini, lihat `shared/security/permissions.ts`),
// tapi rute ini sekarang menyatakan kapabilitas yang dibutuhkan,
// bukan nama role yang di-hardcode.
userRouter.get(
  '/',
  authMiddleware,
  requirePermission('user.manage'),
  asyncHandler(userController.list)
);

// Soft delete (Phase 3) — permission sama seperti `list`, khusus
// admin. Beda dari otorisasi kepemilikan di Events/Products (yang
// ditegakkan di Service karena butuh cek ownerId), di sini TIDAK ada
// konsep "user menghapus akunnya sendiri" yang diminta spesifikasi,
// jadi cukup permission check di layer routing seperti `list`.
userRouter.delete(
  '/:id',
  authMiddleware,
  requirePermission('user.manage'),
  asyncHandler(userController.remove)
);

// Fase 2 (Data retention & GDPR erasure) — self-service, TIDAK PERNAH
// menerima id dari luar (selalu `req.user`), konfirmasi password
// wajib (lihat `PrivacyService.requestSelfErasure`).
userRouter.post('/me/erasure', authMiddleware, asyncHandler(privacyController.eraseSelf));

// Admin-triggered — permission SAMA dengan `remove`/`list` di atas
// (`user.manage`), dipakai juga oleh job retensi otomatis (lewat
// `PrivacyService.eraseForUser` langsung, bukan lewat endpoint ini).
userRouter.post(
  '/admin/:id/erasure',
  authMiddleware,
  requirePermission('user.manage'),
  asyncHandler(privacyController.eraseByAdmin)
);
