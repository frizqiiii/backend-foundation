import { Router } from 'express';
import { asyncHandler } from '../../../shared/middlewares/async-handler';
import { getHealth, getReadiness } from './health.controller';

export const healthRouter = Router();

healthRouter.get('/health', getHealth);
healthRouter.get('/ready', asyncHandler(getReadiness));
