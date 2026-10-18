import { prisma } from '../../shared/config/database';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';

/**
 * R20 — satu instance `WebhookService` yang dipakai bersama oleh router webhook DAN modul bisnis yang memicu webhook
 * (products, events). Dipisah dari `webhook.routes.ts` supaya modul bisnis tidak perlu meng-import router.
 */
export const webhookService = new WebhookService(new WebhookRepository(prisma));
