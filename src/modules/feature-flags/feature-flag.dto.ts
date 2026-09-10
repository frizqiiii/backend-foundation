import { z } from 'zod';

export interface FeatureFlagDto {
  id: string;
  key: string;
  enabled: boolean;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Dipakai oleh `PUT /feature-flags/:key` — SENGAJA upsert (buat kalau
 * belum ada, update kalau sudah), bukan `POST` create terpisah dari
 * `PATCH` update. Operator ingin "pastikan flag X ada dan bernilai
 * Y" tanpa perlu tahu/peduli apakah flag itu sudah pernah dibuat
 * sebelumnya — dua langkah terpisah (cek dulu, baru create-atau-
 * update) hanya menambah race condition tanpa manfaat.
 */
export const upsertFeatureFlagSchema = z.object({
  enabled: z.boolean(),
  description: z.string().max(500).optional(),
});

export type UpsertFeatureFlagInput = z.infer<typeof upsertFeatureFlagSchema>;
