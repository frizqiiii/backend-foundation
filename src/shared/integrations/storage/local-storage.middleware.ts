import type { Application } from 'express';
import express from 'express';
import { env } from '../../config/env';
import { logger } from '../../logger';

/**
 * Rute static `/local-uploads` — HANYA dipasang kalau
 * `OBJECT_STORAGE_PROVIDER=local` (lihat
 * `shared/integrations/storage/local-storage.provider.ts`). Untuk
 * `OBJECT_STORAGE_PROVIDER=s3` (default), rute ini TIDAK dipasang
 * sama sekali — file selalu diakses langsung dari S3 lewat URL yang
 * dikembalikan `s3StorageProvider`, bukan lewat aplikasi ini.
 */
export function mountLocalStorage(app: Application): void {
  if (env.OBJECT_STORAGE_PROVIDER !== 'local') {
    return;
  }

  app.use('/local-uploads', express.static(env.LOCAL_STORAGE_DIR));
  logger.info(
    { dir: env.LOCAL_STORAGE_DIR },
    'Local storage provider aktif — file diserve dari /local-uploads (HANYA untuk development, lihat catatan di local-storage.provider.ts)'
  );
}
