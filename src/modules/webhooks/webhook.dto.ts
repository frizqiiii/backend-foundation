import { z } from 'zod';
import { WEBHOOK_EVENT_TYPE_LIST } from './webhook.events';

export const createWebhookEndpointSchema = z.object({
  url: z.string().url('URL tidak valid'),
  // R20b — hanya event type yang benar-benar dipicu aplikasi (`WEBHOOK_EVENT_TYPES`). Nama bebas sebelumnya membuat
  // salah ketik (mis. `prduct.created`) tersimpan dan diam-diam tidak pernah cocok dengan event mana pun.
  eventTypes: z
    .array(
      z.enum(WEBHOOK_EVENT_TYPE_LIST, {
        errorMap: () => ({
          message:
            'Event type tidak dikenal. Lihat daftar event type yang didukung di dokumentasi API',
        }),
      })
    )
    .min(1, 'Minimal satu event type harus dipilih'),
});
export type CreateWebhookEndpointDto = z.infer<typeof createWebhookEndpointSchema>;

/**
 * Dikembalikan HANYA SEKALI, tepat setelah registrasi — pola yang
 * sama dengan `CreateApiKeyResponseDto` (Phase 12)/recovery code MFA:
 * `secret` mentah TIDAK PERNAH ditampilkan lagi setelah ini (tersimpan
 * TERENKRIPSI di database, lihat `WebhookService.register`).
 */
export interface CreateWebhookEndpointResponseDto {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
}

export interface WebhookEndpointSummaryDto {
  id: string;
  url: string;
  eventTypes: string[];
  active: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}
