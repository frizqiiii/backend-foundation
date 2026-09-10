import type { Request, Response } from 'express';
import { DashboardController } from './dashboard.controller';
import type { DashboardService } from './dashboard.service';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('DashboardController', () => {
  let dashboardService: jest.Mocked<DashboardService>;
  let controller: DashboardController;

  beforeEach(() => {
    dashboardService = {
      getStats: jest.fn(),
      getAuditSummary: jest.fn(),
    } as unknown as jest.Mocked<DashboardService>;
    controller = new DashboardController(dashboardService);
  });

  describe('getStats', () => {
    it('endpoint publik-di-level-controller (otorisasi di routing): membalas statistik dari service', async () => {
      const req = {} as Request;
      const res = createMockResponse();
      const stats = { totals: { users: 10, events: 2, products: 3, uploads: 1 } };
      dashboardService.getStats.mockResolvedValue(stats as never);

      await controller.getStats(req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: stats }));
    });
  });

  describe('getAuditSummary', () => {
    it('meneruskan {from,to} sebagai satu objek kalau KEDUANYA diisi', async () => {
      const req = {
        query: { from: '2026-01-01', to: '2026-01-31' },
      } as unknown as Request;
      const res = createMockResponse();
      dashboardService.getAuditSummary.mockResolvedValue({
        byAction: {},
        totalEntries: 0,
      } as never);

      await controller.getAuditSummary(req, res);

      expect(dashboardService.getAuditSummary).toHaveBeenCalledWith({
        from: new Date('2026-01-01'),
        to: new Date('2026-01-31'),
      });
    });

    it('meneruskan undefined kalau KEDUANYA tidak diisi', async () => {
      const req = { query: {} } as unknown as Request;
      const res = createMockResponse();
      dashboardService.getAuditSummary.mockResolvedValue({
        byAction: {},
        totalEntries: 0,
      } as never);

      await controller.getAuditSummary(req, res);

      expect(dashboardService.getAuditSummary).toHaveBeenCalledWith(undefined);
    });

    it('P5 — menolak kalau HANYA salah satu dari from/to diisi (ambigu, refine menegakkan pasangan)', async () => {
      const req = { query: { from: '2026-01-01' } } as unknown as Request;
      const res = createMockResponse();

      await expect(controller.getAuditSummary(req, res)).rejects.toThrow();
      expect(dashboardService.getAuditSummary).not.toHaveBeenCalled();
    });
  });
});
