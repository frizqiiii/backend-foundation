import type { Request, Response } from 'express';
import { AnalyticsController } from './analytics.controller';
import type { AnalyticsService } from './analytics.service';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('AnalyticsController', () => {
  let analyticsService: jest.Mocked<AnalyticsService>;
  let controller: AnalyticsController;

  beforeEach(() => {
    analyticsService = {
      getDailyActiveUsers: jest.fn(),
    } as unknown as jest.Mocked<AnalyticsService>;
    controller = new AnalyticsController(analyticsService);
  });

  it('meneruskan days dari query (di-coerce ke number) ke service', async () => {
    const req = { query: { days: '14' } } as unknown as Request;
    const res = createMockResponse();
    const result = [{ date: '2026-09-01', count: 5 }];
    analyticsService.getDailyActiveUsers.mockResolvedValue(result as never);

    await controller.getDailyActiveUsers(req, res);

    expect(analyticsService.getDailyActiveUsers).toHaveBeenCalledWith(14);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: result }));
  });

  it('P5 — meneruskan undefined ke service kalau days tidak diisi (Service yang menentukan default)', async () => {
    const req = { query: {} } as unknown as Request;
    const res = createMockResponse();
    analyticsService.getDailyActiveUsers.mockResolvedValue([] as never);

    await controller.getDailyActiveUsers(req, res);

    expect(analyticsService.getDailyActiveUsers).toHaveBeenCalledWith(undefined);
  });

  it('P5 — menolak days di luar batas 1-90', async () => {
    const req = { query: { days: '91' } } as unknown as Request;
    const res = createMockResponse();

    await expect(controller.getDailyActiveUsers(req, res)).rejects.toThrow();
    expect(analyticsService.getDailyActiveUsers).not.toHaveBeenCalled();
  });
});
