import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { requireTenantOrPlatformAdmin } from '../../shared/middlewares/stats-scope.middleware';
import { DashboardRepository } from '../dashboard/dashboard.repository';
import { AnalyticsRepository } from '../analytics/analytics.repository';
import { ReportingService } from './reporting.service';
import { ReportingController } from './reporting.controller';

const dashboardRepository = new DashboardRepository(prisma);
const analyticsRepository = new AnalyticsRepository(prisma);
const reportingService = new ReportingService(dashboardRepository, analyticsRepository);
const reportingController = new ReportingController(reportingService);

export const reportingRouter = Router();

// `requirePermission('dashboard.read')` — lihat catatan yang sama di
// `analytics.routes.ts`/`export.routes.ts`: kelas kapabilitas yang
// sama dengan `/dashboard/*`, bukan permission baru.
reportingRouter.get(
  '/users',
  authMiddleware,
  requirePermission('dashboard.read'),
  requireTenantOrPlatformAdmin,
  asyncHandler(reportingController.getUserStatistics)
);
reportingRouter.get(
  '/events',
  authMiddleware,
  requirePermission('dashboard.read'),
  requireTenantOrPlatformAdmin,
  asyncHandler(reportingController.getEventStatistics)
);
reportingRouter.get(
  '/products',
  authMiddleware,
  requirePermission('dashboard.read'),
  requireTenantOrPlatformAdmin,
  asyncHandler(reportingController.getProductStatistics)
);
reportingRouter.get(
  '/system',
  authMiddleware,
  requirePermission('dashboard.read'),
  requireTenantOrPlatformAdmin,
  asyncHandler(reportingController.getSystemStatistics)
);

export { reportingService };
