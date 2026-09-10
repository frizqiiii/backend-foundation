import type { Request, Response, NextFunction } from 'express';
import {
  httpRequestsTotal,
  httpRequestDurationSeconds,
  httpRequestsActive,
  httpErrorsTotal,
} from './metrics.registry';

/**
 * Mengambil path PATTERN dari route yang cocok (mis. `/api/v1/events/:id`),
 * bukan URL mentah. Express baru mengisi `req.route` SETELAH routing
 * selesai mencocokkan handler — jadi ini WAJIB dibaca di dalam callback
 * `res.on('finish', ...)` (setelah handler jalan), bukan di awal
 * middleware saat request baru masuk.
 *
 * `req.baseUrl + req.route.path` dipakai (bukan `req.route.path` saja)
 * supaya prefix router (mis. `/api/v1/events` dari `app.use('/api/v1',
 * eventRouter)`) ikut tercatat — tanpa ini, route dari modul berbeda
 * yang kebetulan punya sub-path sama (mis. dua-duanya punya `/:id`)
 * akan tertukar jadi satu label yang sama di metric.
 *
 * Kalau tidak ada route yang cocok sama sekali (404 murni), fallback ke
 * `'unmatched'` — mencegah cardinality meledak dari path acak/scan bot
 * yang tidak pernah cocok route manapun.
 */
function resolveRouteLabel(req: Request): string {
  if (req.route) {
    return `${req.baseUrl}${req.route.path}`;
  }
  return 'unmatched';
}

/**
 * Middleware instrumentasi metrics — dipasang PALING AWAL di
 * `app.ts` (setelah Helmet, sebelum route lain) supaya SETIAP request
 * yang masuk tercatat, termasuk yang berujung error di middleware lain
 * (CORS ditolak, rate limit, dst).
 *
 * Pencatatan durasi & counter dilakukan di listener `res.on('finish')`,
 * BUKAN langsung setelah `next()` — `next()` hanya meneruskan ke
 * middleware berikutnya, response belum tentu selesai dikirim ke
 * client saat itu. `finish` adalah event resmi Express/Node yang baru
 * terpicu setelah seluruh response body selesai di-flush.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = process.hrtime.bigint();
  httpRequestsActive.inc({ method: req.method });

  res.on('finish', () => {
    const route = resolveRouteLabel(req);
    const statusCode = String(res.statusCode);
    const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;

    const labels = { method: req.method, route, status_code: statusCode };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
    httpRequestsActive.dec({ method: req.method });

    if (res.statusCode >= 400) {
      httpErrorsTotal.inc(labels);
    }
  });

  next();
}
