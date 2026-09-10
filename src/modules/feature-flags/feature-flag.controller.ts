import type { Request, Response } from 'express';
import type { FeatureFlagService } from './feature-flag.service';
import { upsertFeatureFlagSchema } from './feature-flag.dto';
import { sendSuccess } from '../../shared/utils/response';

export class FeatureFlagController {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  list = async (_req: Request, res: Response): Promise<void> => {
    const flags = await this.featureFlagService.listAll();
    sendSuccess(res, 200, 'Daftar feature flag berhasil diambil', flags);
  };

  upsert = async (req: Request, res: Response): Promise<void> => {
    const input = upsertFeatureFlagSchema.parse(req.body);
    const flag = await this.featureFlagService.upsert(req.params.key, input);
    sendSuccess(res, 200, 'Feature flag berhasil diperbarui', flag);
  };
}
