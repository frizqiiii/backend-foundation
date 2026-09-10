import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { idempotencyMiddleware } from '../../shared/reliability/idempotency.middleware';
import { ExportRepository } from './export.repository';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';
import { UserRepository } from '../users/user.repository';
import { AuditRepository } from '../audit/audit.repository';
import { DashboardRepository } from '../dashboard/dashboard.repository';
import { DashboardService } from '../dashboard/dashboard.service';
import { AnalyticsRepository } from '../analytics/analytics.repository';
import { AnalyticsService } from '../analytics/analytics.service';
import { ReportingService } from '../reporting/reporting.service';

const exportRepository = new ExportRepository(prisma);
const userRepository = new UserRepository(prisma);
const auditRepository = new AuditRepository(prisma);
const dashboardRepository = new DashboardRepository(prisma);
const dashboardService = new DashboardService(dashboardRepository);
// Phase 20 — dipakai dua tempat (routing `/reporting`, `/analytics`
// masing-masing punya instance sendiri di `reporting.routes.ts`/
// `analytics.routes.ts`; instance DI SINI KHUSUS untuk dipakai
// `ExportService` memproses tipe export `*_STATISTICS`/
// `DAILY_ACTIVE_USERS`). Instance terpisah, BUKAN masalah — kedua
// Service ini stateless (tidak menyimpan state apa pun selain
// referensi ke repository), jadi punya beberapa instance sekaligus
// aman, sama seperti `dashboardService` di atas yang juga instance
// terpisah dari yang dipakai `dashboard.routes.ts`.
const analyticsRepository = new AnalyticsRepository(prisma);
const analyticsService = new AnalyticsService(analyticsRepository);
const reportingService = new ReportingService(dashboardRepository, analyticsRepository);
const exportService = new ExportService(
  exportRepository,
  userRepository,
  auditRepository,
  dashboardService,
  reportingService,
  analyticsService
);
const exportController = new ExportController(exportService);

export const exportRouter = Router();

// Phase 19 — `idempotencyMiddleware` dipasang di sini juga (pola
// sama dengan `POST /webhooks`, lihat Phase 18): retry naif dari
// client (mis. karena response 202 sempat tidak sampai walau
// request-nya sudah diterima) tidak boleh membuat export job dobel
// (query 5000 baris + generate file berulang kali sia-sia).
// Phase 19 — SEMUA tipe export saat ini (USERS/AUDIT_LOG/
// DASHBOARD_STATS) adalah data lintas-user/agregat, BUKAN data milik
// satu user biasa — `requirePermission('dashboard.read')` yang SAMA
// dengan endpoint `/dashboard` (bukan permission baru), karena
// kelasnya memang sama: data sensitif level admin.
exportRouter.post(
  '/',
  authMiddleware,
  requirePermission('dashboard.read'),
  idempotencyMiddleware({ scope: 'exports.create' }),
  asyncHandler(exportController.create)
);
exportRouter.get(
  '/:id',
  authMiddleware,
  requirePermission('dashboard.read'),
  asyncHandler(exportController.getStatus)
);
exportRouter.get(
  '/:id/download',
  authMiddleware,
  requirePermission('dashboard.read'),
  asyncHandler(exportController.download)
);

export { exportService };
