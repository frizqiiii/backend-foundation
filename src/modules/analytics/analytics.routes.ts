import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { AnalyticsRepository } from './analytics.repository';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

const analyticsRepository = new AnalyticsRepository(prisma);
const analyticsService = new AnalyticsService(analyticsRepository);
const analyticsController = new AnalyticsController(analyticsService);

export const analyticsRouter = Router();

// `requirePermission('dashboard.read')` — SAMA dengan `/dashboard/*`
// (bukan permission baru), pola yang SAMA persis dengan alasan yang
// dipakai `/exports` (lihat komentar `export.routes.ts`): metrik
// agregat lintas-user adalah kelas kapabilitas yang sama dengan
// statistik dashboard, bukan kapabilitas baru yang berhak dapat
// permission sendiri.
analyticsRouter.get(
  '/daily-active-users',
  authMiddleware,
  requirePermission('dashboard.read'),
  asyncHandler(analyticsController.getDailyActiveUsers)
);

export { analyticsService, analyticsRepository };
