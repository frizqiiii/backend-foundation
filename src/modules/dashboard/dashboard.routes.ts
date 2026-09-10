import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

const dashboardRepository = new DashboardRepository(prisma);
const dashboardService = new DashboardService(dashboardRepository);
const dashboardController = new DashboardController(dashboardService);

export const dashboardRouter = Router();

dashboardRouter.get(
  '/stats',
  authMiddleware,
  requirePermission('dashboard.read'),
  asyncHandler(dashboardController.getStats)
);
dashboardRouter.get(
  '/audit-summary',
  authMiddleware,
  requirePermission('dashboard.read'),
  asyncHandler(dashboardController.getAuditSummary)
);
