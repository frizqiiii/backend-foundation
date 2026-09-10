import { Router } from 'express';
import { asyncHandler } from '../../../shared/middlewares/async-handler';
import { getMetrics } from './metrics.controller';

export const metricsRouter = Router();

metricsRouter.get('/', asyncHandler(getMetrics));
