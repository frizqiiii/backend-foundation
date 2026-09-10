import { z } from 'zod';

export const createWebhookEndpointSchema = z.object({
  url: z.string().url('URL tidak valid'),
  eventTypes: z.array(z.string()).min(1, 'Minimal satu event type harus dipilih'),
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
