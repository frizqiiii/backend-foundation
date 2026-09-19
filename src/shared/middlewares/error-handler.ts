import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { HttpError } from '../utils/http-error';
import { env } from '../config/env';
import { logger } from '../logger';
import { getRequestLocale } from '../i18n/locale';
import { translateFieldErrors, translateMessage } from '../i18n/translate';

/**
 * Global error handler — satu-satunya tempat yang membentuk response
 * error final ke client. Controller/Service cukup `throw`, tidak perlu
 * tahu format response error.
 *
 * Envelope `{ success: false, message, ... }` SENGAJA dibuat seragam
 * dengan `success: true` di `shared/utils/response.ts` — klien bisa
 * selalu cek `body.success` sebagai satu-satunya sinyal sukses/gagal,
 * tanpa perlu menebak dari HTTP status code semata.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Fase 2 (item 2.13 — i18n): `message` dan pesan validasi diterjemahkan
  // sesuai `Accept-Language` (default `id` = teks sumber apa adanya).
  const locale = getRequestLocale(req, res);

  if (err instanceof ZodError) {
    res.status(422).json({
      success: false,
      message: 'Validation failed',
      errors: translateFieldErrors(err.flatten().fieldErrors, locale),
    });
    return;
  }

  if (err instanceof HttpError) {
    res
      .status(err.statusCode)
      .json({ success: false, message: translateMessage(err.message, locale) });
    return;
  }

  /**
   * Multer melempar `MulterError` sendiri (bukan `HttpError` kita)
   * untuk pelanggaran seperti ukuran file melebihi batas — tanpa
   * penanganan eksplisit ini, error tersebut jatuh ke cabang 500
   * generik di bawah, padahal ini murni kesalahan input client (400),
   * bukan kegagalan server.
   */
  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'Ukuran file melebihi batas maksimal yang diizinkan'
        : `Upload gagal: ${err.message}`;
    res.status(400).json({ success: false, message: translateMessage(message, locale) });
    return;
  }

  // Error tak terduga — jangan bocorkan detail internal di production.
  // Sentry.captureException TIDAK dipanggil manual di sini — sudah
  // ditangani oleh Sentry.setupExpressErrorHandler (lihat app.ts),
  // yang dipasang SEBELUM handler ini di rantai middleware. Memanggil
  // captureException di kedua tempat akan melaporkan error yang sama
  // dua kali ke Sentry.
  logger.error({ err, method: req.method, path: req.originalUrl }, 'Unhandled error');
  res.status(500).json({
    success: false,
    message: env.NODE_ENV === 'production' ? 'Internal server error' : String(err),
  });
}
