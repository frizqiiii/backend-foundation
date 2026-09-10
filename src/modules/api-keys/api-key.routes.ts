import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';

const apiKeyRepository = new ApiKeyRepository(prisma);
const apiKeyService = new ApiKeyService(apiKeyRepository);
const apiKeyController = new ApiKeyController(apiKeyService);

export const apiKeyRouter = Router();

// Seluruh endpoint self-service (lihat komentar `ApiKeyController`) —
// hanya butuh `authMiddleware`, tidak ada permission khusus, sama pola
// dengan `/auth/mfa/*` dan `/auth/sessions`.
apiKeyRouter.post('/', authMiddleware, asyncHandler(apiKeyController.create));
apiKeyRouter.get('/', authMiddleware, asyncHandler(apiKeyController.list));
apiKeyRouter.delete('/:id', authMiddleware, asyncHandler(apiKeyController.revoke));

export { apiKeyService };
