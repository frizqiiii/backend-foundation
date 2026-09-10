import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { upload } from '../../shared/middlewares/upload.middleware';
import { UploadRepository } from './upload.repository';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { ActivityRepository } from '../activity/activity.repository';
import { ActivityService } from '../activity/activity.service';
import { requirePermission } from '../../shared/middlewares/permission.middleware';

/**
 * Composition root untuk modul `upload`.
 *
 * Endpoint diproteksi `authMiddleware` — upload publik tanpa login
 * adalah vektor abuse umum (spam storage, biaya S3 membengkak).
 * Urutan middleware WAJIB: authMiddleware → upload.single (multer,
 * menegakkan batas ukuran/tipe) → controller.
 */
const uploadRepository = new UploadRepository(prisma);
const uploadService = new UploadService(uploadRepository);
const activityService = new ActivityService(new ActivityRepository(prisma));
const uploadController = new UploadController(uploadService, activityService);

export const uploadRouter = Router();

uploadRouter.post(
  '/',
  authMiddleware,
  requirePermission('upload.create'),
  upload.single('file'),
  asyncHandler(uploadController.uploadSingle)
);

// "Access" (Phase 4) — otorisasi kepemilikan (pemilik ATAU
// `upload.moderate`) ditegakkan di `UploadService`, sama seperti
// pola ownership-scoped di Events/Products (bukan requirePermission
// di layer routing, karena butuh cek ownerId per baris).
uploadRouter.get('/:id', authMiddleware, asyncHandler(uploadController.getById));

// "Delete" (Phase 4) — sama seperti di atas.
uploadRouter.delete('/:id', authMiddleware, asyncHandler(uploadController.remove));
