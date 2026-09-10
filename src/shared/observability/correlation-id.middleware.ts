import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { runWithCorrelationId } from './correlation-id';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Correlation ID Middleware (Phase 13) — dipasang SEDINI mungkin di
 * `app.ts` (sebelum `pinoHttp`, supaya `genReqId` pino-http bisa
 * memakai correlation ID yang sama — lihat wiring di `app.ts`).
 *
 * Kalau caller SUDAH mengirim `X-Correlation-ID` (mis. gateway/proxy
 * di depan aplikasi, atau service lain yang meneruskan ID dari
 * request upstream-nya), ID tersebut DIPAKAI ULANG — bukan diganti
 * dengan yang baru. Ini yang membuat penelusuran lintas-service
 * mungkin: satu ID yang sama mengalir dari ujung ke ujung, bukan
 * berganti-ganti di setiap loncatan.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_ID_HEADER];
  const correlationId = (Array.isArray(incoming) ? incoming[0] : incoming) || crypto.randomUUID();

  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  runWithCorrelationId(correlationId, () => next());
}
