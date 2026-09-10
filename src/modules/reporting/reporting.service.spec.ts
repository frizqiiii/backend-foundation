import { ReportingService } from './reporting.service';
import type { DashboardRepository } from '../dashboard/dashboard.repository';
import type { AnalyticsRepository } from '../analytics/analytics.repository';

describe('ReportingService', () => {
  let dashboardRepository: jest.Mocked<DashboardRepository>;
  let analyticsRepository: jest.Mocked<AnalyticsRepository>;
  let reportingService: ReportingService;

  beforeEach(() => {
    dashboardRepository = {
      countUsers: jest.fn(),
      countEvents: jest.fn(),
      countProducts: jest.fn(),
      countUploads: jest.fn(),
      countUsersByRole: jest.fn(),
      countEventsByCategory: jest.fn(),
      countProductsByStatus: jest.fn(),
      countProductsByCategory: jest.fn(),
      countEventsUpcomingVsPast: jest.fn(),
      signupsLast30Days: jest.fn(),
      countAuditLogsByAction: jest.fn(),
    } as unknown as jest.Mocked<DashboardRepository>;

    analyticsRepository = {
      dailyActiveUsers: jest.fn(),
    } as unknown as jest.Mocked<AnalyticsRepository>;

    reportingService = new ReportingService(dashboardRepository, analyticsRepository);
  });

  describe('getUserStatistics', () => {
    it('menggabungkan total, breakdown role, dan tren signup', async () => {
      dashboardRepository.countUsers.mockResolvedValue(42);
      dashboardRepository.countUsersByRole.mockResolvedValue([
        { role: 'USER', count: 40 },
        { role: 'ADMIN', count: 2 },
      ]);
      dashboardRepository.signupsLast30Days.mockResolvedValue([{ date: '2026-08-06', count: 1 }]);

      const result = await reportingService.getUserStatistics();

      expect(result).toEqual({
        total: 42,
        byRole: { USER: 40, ADMIN: 2 },
        signupsLast30Days: [{ date: '2026-08-06', count: 1 }],
      });
    });
  });

  describe('getEventStatistics', () => {
    it('menggabungkan total, breakdown kategori, dan upcoming/past', async () => {
      dashboardRepository.countEvents.mockResolvedValue(10);
      dashboardRepository.countEventsByCategory.mockResolvedValue([
        { category: 'seminar', count: 6 },
        { category: 'workshop', count: 4 },
      ]);
      dashboardRepository.countEventsUpcomingVsPast.mockResolvedValue({ upcoming: 7, past: 3 });

      const result = await reportingService.getEventStatistics();

      expect(result).toEqual({
        total: 10,
        byCategory: { seminar: 6, workshop: 4 },
        upcoming: 7,
        past: 3,
      });
    });
  });

  describe('getProductStatistics', () => {
    it('menggabungkan total, breakdown status, dan breakdown kategori', async () => {
      dashboardRepository.countProducts.mockResolvedValue(15);
      dashboardRepository.countProductsByStatus.mockResolvedValue([
        { status: 'ACTIVE', count: 12 },
        { status: 'SOLD', count: 3 },
      ]);
      dashboardRepository.countProductsByCategory.mockResolvedValue([
        { category: 'STANDARD', count: 15 },
      ]);

      const result = await reportingService.getProductStatistics();

      expect(result).toEqual({
        total: 15,
        byStatus: { ACTIVE: 12, SOLD: 3 },
        byCategory: { STANDARD: 15 },
      });
    });
  });

  describe('getSystemStatistics', () => {
    it('menggabungkan total upload, audit log per action, dan tren DAU 30 hari', async () => {
      dashboardRepository.countUploads.mockResolvedValue(99);
      dashboardRepository.countAuditLogsByAction.mockResolvedValue([
        { action: 'LOGIN', count: 50 },
        { action: 'LOGIN_FAILED', count: 5 },
      ]);
      analyticsRepository.dailyActiveUsers.mockResolvedValue([{ date: '2026-08-06', count: 8 }]);

      const result = await reportingService.getSystemStatistics();

      expect(analyticsRepository.dailyActiveUsers).toHaveBeenCalledWith(30);
      expect(result).toEqual({
        totalUploads: 99,
        auditLogByAction: { LOGIN: 50, LOGIN_FAILED: 5 },
        dailyActiveUsersLast30Days: [{ date: '2026-08-06', count: 8 }],
      });
    });
  });
});
