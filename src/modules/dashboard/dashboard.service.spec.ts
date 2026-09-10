import { DashboardService } from './dashboard.service';
import type { DashboardRepository } from './dashboard.repository';

describe('DashboardService', () => {
  let dashboardRepository: jest.Mocked<DashboardRepository>;
  let dashboardService: DashboardService;

  beforeEach(() => {
    dashboardRepository = {
      countUsers: jest.fn(),
      countEvents: jest.fn(),
      countProducts: jest.fn(),
      countUploads: jest.fn(),
      countUsersByRole: jest.fn(),
      countEventsByCategory: jest.fn(),
      signupsLast30Days: jest.fn(),
      countAuditLogsByAction: jest.fn(),
    } as unknown as jest.Mocked<DashboardRepository>;

    dashboardService = new DashboardService(dashboardRepository);
  });

  describe('getStats', () => {
    it('menggabungkan seluruh hasil query paralel jadi satu DTO', async () => {
      dashboardRepository.countUsers.mockResolvedValue(10);
      dashboardRepository.countEvents.mockResolvedValue(5);
      dashboardRepository.countProducts.mockResolvedValue(3);
      dashboardRepository.countUploads.mockResolvedValue(20);
      dashboardRepository.countUsersByRole.mockResolvedValue([
        { role: 'USER', count: 8 },
        { role: 'ADMIN', count: 2 },
      ]);
      dashboardRepository.countEventsByCategory.mockResolvedValue([
        { category: 'seminar', count: 5 },
      ]);
      dashboardRepository.signupsLast30Days.mockResolvedValue([
        { date: '2026-07-30', count: 1 },
        { date: '2026-07-31', count: 0 },
      ]);

      const result = await dashboardService.getStats();

      expect(result).toEqual({
        totals: { users: 10, events: 5, products: 3, uploads: 20 },
        usersByRole: { USER: 8, ADMIN: 2 },
        eventsByCategory: { seminar: 5 },
        signupsLast30Days: [
          { date: '2026-07-30', count: 1 },
          { date: '2026-07-31', count: 0 },
        ],
      });
    });
  });

  describe('getAuditSummary', () => {
    it('menghitung totalEntries sebagai jumlah seluruh action', async () => {
      dashboardRepository.countAuditLogsByAction.mockResolvedValue([
        { action: 'LOGIN_SUCCESS', count: 15 },
        { action: 'LOGIN_FAILED', count: 3 },
      ]);

      const result = await dashboardService.getAuditSummary();

      expect(result).toEqual({
        byAction: { LOGIN_SUCCESS: 15, LOGIN_FAILED: 3 },
        totalEntries: 18,
      });
    });

    it('meneruskan range tanggal ke repository ketika diberikan', async () => {
      dashboardRepository.countAuditLogsByAction.mockResolvedValue([]);
      const range = { from: new Date('2026-07-01'), to: new Date('2026-07-31') };

      await dashboardService.getAuditSummary(range);

      expect(dashboardRepository.countAuditLogsByAction).toHaveBeenCalledWith(range);
    });
  });
});
