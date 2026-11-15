import { z } from 'zod';
import { WEBHOOK_EVENT_TYPE_LIST } from './webhook.events';

export const createWebhookEndpointSchema = z.object({
  url: z.string().url('URL tidak valid'),
  // R20b — hanya event type yang benar-benar dipicu aplikasi (`WEBHOOK_EVENT_TYPES`). Nama bebas sebelumnya membuat
  // salah ketik (mis. `prduct.created`) tersimpan dan diam-diam tidak pernah cocok dengan event mana pun.
  // Batas jumlah memakai `.pipe()`, BUKAN `.max()` langsung pada array enum: Zod tetap memeriksa SETIAP elemen sebelum
  // melaporkan "terlalu panjang" (body 100 KB berisi puluhan ribu nama salah = puluhan ribu isu dan puluhan MB heap).
  // Dengan `.pipe()` tahap kedua dilewati begitu tahap pertama (jumlah) gagal. Batas = jumlah event type yang valid.
  eventTypes: z
    .array(z.unknown())
    .max(WEBHOOK_EVENT_TYPE_LIST.length, 'Jumlah event type melebihi batas yang diizinkan')
    .pipe(
      z
        .array(
          z.enum(WEBHOOK_EVENT_TYPE_LIST, {
            errorMap: () => ({
              message:
                'Event type tidak dikenal. Lihat daftar event type yang didukung di dokumentasi API',
            }),
          })
        )
        .min(1, 'Minimal satu event type harus dipilih')
    ),
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
