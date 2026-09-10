import type { Request, Response } from 'express';
import { metricsRegistry } from './metrics.registry';

/**
 * `GET /metrics` — endpoint scrape target untuk Prometheus.
 *
 * SENGAJA tidak memakai `sendSuccess`/amplop JSON standar aplikasi —
 * Prometheus mengharapkan format teks `text/plain` versi tertentu
 * (`Content-Type` dari `registry.contentType`), bukan JSON. Endpoint
 * ini juga TIDAK dipasang di bawah `/api/v1` (lihat app.ts) — sama
 * seperti `/health`, ini kontrak infrastruktur/observability, bukan
 * resource API bisnis yang perlu versioning.
 *
 * Tidak ada try/catch manual di sini — dibungkus `asyncHandler` di
 * routes supaya error tak terduga tetap jatuh ke `errorHandler`
 * terpusat, konsisten dengan seluruh controller lain di aplikasi.
 */
export async function getMetrics(_req: Request, res: Response): Promise<void> {
  res.set('Content-Type', metricsRegistry.contentType);
  res.end(await metricsRegistry.metrics());
}
