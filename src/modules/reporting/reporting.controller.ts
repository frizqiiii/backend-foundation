import type { Request, Response } from 'express';
import type { ReportingService } from './reporting.service';
import { sendSuccess } from '../../shared/utils/response';

export class ReportingController {
  constructor(private readonly reportingService: ReportingService) {}

  getUserStatistics = async (_req: Request, res: Response): Promise<void> => {
    const stats = await this.reportingService.getUserStatistics();
    sendSuccess(res, 200, 'Statistik user berhasil diambil', stats);
  };

  getEventStatistics = async (_req: Request, res: Response): Promise<void> => {
    const stats = await this.reportingService.getEventStatistics();
    sendSuccess(res, 200, 'Statistik event berhasil diambil', stats);
  };

  getProductStatistics = async (_req: Request, res: Response): Promise<void> => {
    const stats = await this.reportingService.getProductStatistics();
    sendSuccess(res, 200, 'Statistik produk berhasil diambil', stats);
  };

  getSystemStatistics = async (_req: Request, res: Response): Promise<void> => {
    const stats = await this.reportingService.getSystemStatistics();
    sendSuccess(res, 200, 'Statistik sistem berhasil diambil', stats);
  };
}
