import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { requirePermission } from '../../shared/middlewares/permission.middleware';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { AuditRepository } from '../audit/audit.repository';
import { AuditService } from '../audit/audit.service';

const apiKeyRepository = new ApiKeyRepository(prisma);
const apiKeyService = new ApiKeyService(apiKeyRepository);
const auditService = new AuditService(new AuditRepository(prisma));
const apiKeyController = new ApiKeyController(apiKeyService, auditService);

export const apiKeyRouter = Router();

// Seluruh endpoint self-service (lihat komentar `ApiKeyController`) —
// hanya butuh `authMiddleware`, tidak ada permission khusus, sama pola
// dengan `/auth/mfa/*` dan `/auth/sessions`.
apiKeyRouter.post('/', authMiddleware, asyncHandler(apiKeyController.create));
apiKeyRouter.get('/', authMiddleware, asyncHandler(apiKeyController.list));
apiKeyRouter.delete('/:id', authMiddleware, asyncHandler(apiKeyController.revoke));
// T4 — admin, permission `api-key.manage`, BEDA dari tiga di atas:
// menjangkau key milik user MANA PUN, bukan cuma milik sendiri.
apiKeyRouter.patch(
  '/:id/rate-limit-override',
  authMiddleware,
  requirePermission('api-key.manage'),
  asyncHandler(apiKeyController.updateRateLimitOverride)
);

export { apiKeyService };
