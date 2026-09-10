import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AnalyticsService } from './analytics.service';
import { sendSuccess } from '../../shared/utils/response';

const dailyActiveUsersQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  getDailyActiveUsers = async (req: Request, res: Response): Promise<void> => {
    const { days } = dailyActiveUsersQuerySchema.parse(req.query);
    const result = await this.analyticsService.getDailyActiveUsers(days);
    sendSuccess(res, 200, 'Daily active users berhasil diambil', result);
  };
}
