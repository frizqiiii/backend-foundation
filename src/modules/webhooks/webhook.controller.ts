import type { Request, Response } from 'express';
import type { WebhookService } from './webhook.service';
import { createWebhookEndpointSchema } from './webhook.dto';
import { sendSuccess } from '../../shared/utils/response';
import { UnauthorizedError } from '../../shared/utils/http-error';

/**
 * Self-service SEPENUHNYA, pola yang sama dengan `ApiKeyController`
 * (Phase 12) — `req.user` menentukan pemilik endpoint, tidak pernah
 * menerima `userId` dari body.
 */
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  create = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const input = createWebhookEndpointSchema.parse(req.body);
    const result = await this.webhookService.register({ id: user.id }, input);

    sendSuccess(
      res,
      201,
      'Webhook endpoint berhasil didaftarkan. SIMPAN secret ini sekarang — tidak akan ditampilkan lagi.',
      result
    );
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    const endpoints = await this.webhookService.listForUser(user.id);
    sendSuccess(res, 200, 'Daftar webhook endpoint berhasil diambil', endpoints);
  };

  revoke = async (req: Request, res: Response): Promise<void> => {
    const user = this.requireUser(req);
    await this.webhookService.revoke(user.id, req.params.id);
    sendSuccess(res, 200, 'Webhook endpoint berhasil dicabut', null);
  };

  private requireUser(req: Request): NonNullable<Request['user']> {
    if (!req.user) {
      throw new UnauthorizedError();
    }
    return req.user;
  }
}
