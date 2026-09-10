import crypto from 'node:crypto';
import type { WebhookRepository } from './webhook.repository';
import type {
  CreateWebhookEndpointDto,
  CreateWebhookEndpointResponseDto,
  WebhookEndpointSummaryDto,
} from './webhook.dto';
import { encryptionService } from '../../shared/security/encryption.service';
import { assertSafeOutboundUrl } from '../../shared/security/ssrf-guard';
import { getTenantContext } from '../../shared/tenant/tenant-context';
import { enqueueWebhookDelivery } from '../../shared/queue/webhook-delivery.queue';
import { NotFoundError } from '../../shared/utils/http-error';
import { logger } from '../../shared/logger';

export class WebhookService {
  constructor(private readonly webhookRepository: WebhookRepository) {}

  /**
   * Secret HMAC (lihat `WebhookEndpoint.secret` di schema.prisma)
   * disimpan TERENKRIPSI lewat `EncryptionService` (Phase 12) — SAMA
   * alasannya dengan `User.mfaSecret`: dua-arah, bukan hash satu-arah,
   * karena harus bisa dibaca ulang APA ADANYA saat menandatangani
   * SETIAP payload webhook yang dikirim (`trigger` di bawah), bukan
   * hanya dibandingkan sekali seperti password.
   */
  async register(
    owner: { id: string },
    input: CreateWebhookEndpointDto
  ): Promise<CreateWebhookEndpointResponseDto> {
    // Cegah SSRF (lihat `ssrf-guard.ts`) — ditolak sedini mungkin,
    // sebelum URL ini sempat tersimpan ke database sama sekali.
    await assertSafeOutboundUrl(input.url);

    const rawSecret = crypto.randomBytes(32).toString('hex');
    const { tenantId } = getTenantContext();

    const endpoint = await this.webhookRepository.create({
      userId: owner.id,
      tenantId,
      url: input.url,
      encryptedSecret: encryptionService.encrypt(rawSecret),
      eventTypes: input.eventTypes,
    });

    return {
      id: endpoint.id,
      url: endpoint.url,
      secret: rawSecret,
      eventTypes: endpoint.eventTypes,
    };
  }

  async listForUser(userId: string): Promise<WebhookEndpointSummaryDto[]> {
    const endpoints = await this.webhookRepository.findManyForUser(userId);
    return endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      eventTypes: endpoint.eventTypes,
      active: endpoint.active,
      createdAt: endpoint.createdAt,
      revokedAt: endpoint.revokedAt,
    }));
  }

  async revoke(userId: string, endpointId: string): Promise<void> {
    const endpoint = await this.webhookRepository.findByIdForUser(endpointId, userId);
    if (!endpoint) {
      throw new NotFoundError('Webhook endpoint tidak ditemukan');
    }
    if (!endpoint.active) {
      return; // idempotent
    }
    await this.webhookRepository.revoke(endpointId);
  }

  /**
   * Titik masuk TUNGGAL untuk memicu webhook dari mana pun di
   * aplikasi (mis. `ProductService.create` memanggil
   * `webhookService.trigger('product.created', product)`) — pemanggil
   * TIDAK PERNAH tahu berapa banyak endpoint yang akan menerimanya
   * atau bagaimana pengirimannya (antrian vs sinkron, lihat
   * `enqueueWebhookDelivery`).
   *
   * KEGAGALAN MENGIRIM WEBHOOK TIDAK PERNAH MELEMPAR ERROR ke
   * pemanggil — event bisnis (mis. produk berhasil dibuat) SUDAH
   * terjadi dan SUDAH sukses terlepas dari apakah webhook-nya
   * terkirim; kegagalan pengiriman webhook (retry-nya sendiri
   * ditangani BullMQ, lihat `webhook-delivery.queue.ts`) tidak boleh
   * membatalkan/menggagalkan operasi bisnis yang memicunya.
   */
  async trigger(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const { tenantId } = getTenantContext();
    const endpoints = await this.webhookRepository.findActiveByEventType(eventType, tenantId);

    await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          await enqueueWebhookDelivery({
            webhookEndpointId: endpoint.id,
            url: endpoint.url,
            secret: encryptionService.decrypt(endpoint.secret),
            eventType,
            payload,
            // Finding #22 — dibuat SEKALI di sini (bukan di dalam
            // `processWebhookDeliveryJob`), supaya tetap SAMA di
            // setiap percobaan retry job ini. Lihat komentar lengkap
            // pada `deliveryId` di `WebhookDeliveryJobData`.
            deliveryId: crypto.randomUUID(),
          });
        } catch (error) {
          logger.warn(
            { err: error, webhookEndpointId: endpoint.id, eventType },
            'WebhookService.trigger: gagal enqueue delivery untuk satu endpoint — endpoint lain tetap diproses'
          );
        }
      })
    );
  }
}
