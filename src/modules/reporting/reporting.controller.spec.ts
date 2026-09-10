import type { Request, Response } from 'express';
import { ReportingController } from './reporting.controller';
import type { ReportingService } from './reporting.service';

function createMockResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('ReportingController', () => {
  let reportingService: jest.Mocked<ReportingService>;
  let controller: ReportingController;
  const req = {} as Request;

  beforeEach(() => {
    reportingService = {
      getUserStatistics: jest.fn(),
      getEventStatistics: jest.fn(),
      getProductStatistics: jest.fn(),
      getSystemStatistics: jest.fn(),
    } as unknown as jest.Mocked<ReportingService>;
    controller = new ReportingController(reportingService);
  });

  it('getUserStatistics membalas hasil dari service', async () => {
    const res = createMockResponse();
    const stats = { total: 10 };
    reportingService.getUserStatistics.mockResolvedValue(stats as never);

    await controller.getUserStatistics(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: stats }));
  });

  it('getEventStatistics membalas hasil dari service', async () => {
    const res = createMockResponse();
    const stats = { total: 5 };
    reportingService.getEventStatistics.mockResolvedValue(stats as never);

    await controller.getEventStatistics(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: stats }));
  });

  it('getProductStatistics membalas hasil dari service', async () => {
    const res = createMockResponse();
    const stats = { total: 3 };
    reportingService.getProductStatistics.mockResolvedValue(stats as never);

    await controller.getProductStatistics(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: stats }));
  });

  it('getSystemStatistics membalas hasil dari service', async () => {
    const res = createMockResponse();
    const stats = { totalUploads: 7 };
    reportingService.getSystemStatistics.mockResolvedValue(stats as never);

    await controller.getSystemStatistics(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ data: stats }));
  });
});
