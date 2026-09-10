import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { FeatureFlagRepository } from './feature-flag.repository';
import { FeatureFlagService } from './feature-flag.service';
import { FeatureFlagController } from './feature-flag.controller';

const featureFlagRepository = new FeatureFlagRepository(prisma);
const featureFlagService = new FeatureFlagService(featureFlagRepository);
const featureFlagController = new FeatureFlagController(featureFlagService);

export const featureFlagRouter = Router();

// Seluruh endpoint modul ini (baca DAN tulis) di bawah SATU permission
// `feature-flag.manage` — lihat alasannya di komentar `permissions.ts`.
featureFlagRouter.get(
  '/',
  authMiddleware,
  requirePermission('feature-flag.manage'),
  asyncHandler(featureFlagController.list)
);
featureFlagRouter.put(
  '/:key',
  authMiddleware,
  requirePermission('feature-flag.manage'),
  asyncHandler(featureFlagController.upsert)
);

export { featureFlagService };
