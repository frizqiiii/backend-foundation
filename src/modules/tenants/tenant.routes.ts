import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { TenantRepository } from './tenant.repository';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';

const tenantRepository = new TenantRepository(prisma);
const tenantService = new TenantService(tenantRepository);
const tenantController = new TenantController(tenantService);

export const tenantRouter = Router();

// Seluruh endpoint modul ini di bawah SATU permission `tenant.manage`
// — pola yang sama dengan `feature-flag.routes.ts` (hanya ADMIN yang
// berinteraksi dengan pengelolaan tenant sama sekali di fase ini).
tenantRouter.get(
  '/',
  authMiddleware,
  requirePermission('tenant.manage'),
  asyncHandler(tenantController.list)
);
tenantRouter.post(
  '/',
  authMiddleware,
  requirePermission('tenant.manage'),
  asyncHandler(tenantController.create)
);

export { tenantService };
