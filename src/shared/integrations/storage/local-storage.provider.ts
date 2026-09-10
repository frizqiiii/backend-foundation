import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env';
import type { ObjectStorageProvider, UploadObjectInput } from './storage.provider';

/**
 * Alternatif untuk development lokal/testing TANPA kredensial AWS —
 * menyimpan file langsung ke disk container (`LOCAL_STORAGE_DIR`).
 *
 * TIDAK UNTUK PRODUCTION — lihat juga catatan yang sama di seluruh
 * dokumentasi upload sebelumnya (`docs/`): container/deployment
 * serverless umumnya punya filesystem EPHEMERAL (hilang saat restart)
 * atau READ-ONLY, dan file yang disimpan di SATU instance tidak
 * terlihat oleh instance lain kalau aplikasi di-scale horizontal
 * (Phase 14) — persis masalah yang membuat `s3StorageProvider` jadi
 * pilihan default sejak awal. Provider ini murni untuk pengembangan
 * lokal cepat tanpa perlu setup AWS/MinIO dulu.
 *
 * URL yang dikembalikan mengarah ke rute static
 * `/local-uploads/<key>` yang dipasang `app.ts` HANYA kalau
 * `OBJECT_STORAGE_PROVIDER=local` (lihat komentar di sana).
 */
export const localStorageProvider: ObjectStorageProvider = {
  async upload(input: UploadObjectInput): Promise<{ url: string }> {
    const filePath = path.join(env.LOCAL_STORAGE_DIR, input.key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, input.body);

    return { url: `/local-uploads/${input.key}` };
  },

  async delete(key: string): Promise<void> {
    const filePath = path.join(env.LOCAL_STORAGE_DIR, key);
    await fs.unlink(filePath).catch(() => {
      // Idempotent — sama pola dengan provider lain (mis.
      // `postgresSearchProvider.deleteDocument`): menghapus file yang
      // sudah tidak ada bukan error bagi pemanggil.
    });
  },
};
