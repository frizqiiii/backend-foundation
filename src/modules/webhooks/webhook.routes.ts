import { Router } from 'express';
import { prisma } from '../../shared/config/database';
import { asyncHandler } from '../../shared/middlewares/async-handler';
import { authMiddleware } from '../../shared/middlewares/auth.middleware';
import { idempotencyMiddleware } from '../../shared/reliability/idempotency.middleware';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';
import { WebhookController } from './webhook.controller';

const webhookRepository = new WebhookRepository(prisma);
const webhookService = new WebhookService(webhookRepository);
const webhookController = new WebhookController(webhookService);

export const webhookRouter = Router();

// Phase 18 — `idempotencyMiddleware` diletakkan SETELAH
// `authMiddleware` (WAJIB urutannya begini, bukan sebaliknya) supaya
// `req.user.id` sudah terisi saat middleware ini membaca-nya untuk
// membentuk cache key. HANYA dipasang di `POST` — registrasi endpoint
// webhook adalah operasi non-idempotent secara alami (retry naif
// tanpa ini akan membuat endpoint dobel); `GET`/`DELETE` di bawah
// SUDAH idempotent secara alami (baca berulang aman, hapus berulang
// tetap berakhir di state yang sama), tidak butuh mekanisme ini.
webhookRouter.post(
  '/',
  authMiddleware,
  idempotencyMiddleware({ scope: 'webhooks.create' }),
  asyncHandler(webhookController.create)
);
webhookRouter.get('/', authMiddleware, asyncHandler(webhookController.list));
webhookRouter.delete('/:id', authMiddleware, asyncHandler(webhookController.revoke));

export { webhookService };
