import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { HttpError } from '../utils/http-error';
import { env } from '../config/env';
import { logger } from '../logger';
import { getRequestLocale } from '../i18n/locale';
import { translateFieldErrors, translateMessage } from '../i18n/translate';

/**
 * Error dari body parser Express (`express.json`, via `body-parser`) adalah
 * objek `http-errors`, BUKAN `HttpError` kita: ia membawa `type` yang stabil
 * (`entity.parse.failed`, `entity.too.large`, ...). Tanpa pemetaan ini JSON
 * rusak dan body terlalu besar jatuh ke cabang 500 di bawah — padahal murni
 * kesalahan client (400/413) — dan, di luar production, bocor sebagai
 * `String(err)`.
 *
 * Pemetaan memakai `type` (kontrak body-parser), bukan `instanceof`, dan
 * SENGAJA hanya mengenali jenis yang tercantum: error lain yang kebetulan
 * punya `status` 4xx tetap diperlakukan sebagai tak terduga (500), supaya
 * tidak ada error asing yang diloloskan sebagai "salah client". Pesan
 * dibuat tetap (bukan `err.message`) agar tidak membocorkan detail parser.
 */
const BODY_PARSER_ERRORS: ReadonlyMap<string, { status: number; message: string }> = new Map([
  ['entity.parse.failed', { status: 400, message: 'Body request bukan JSON yang valid' }],
  [
    'entity.too.large',
    { status: 413, message: 'Ukuran body request melebihi batas maksimal yang diizinkan' },
  ],
  [
    'encoding.unsupported',
    { status: 415, message: 'Encoding atau charset body request tidak didukung' },
  ],
  [
    'charset.unsupported',
    { status: 415, message: 'Encoding atau charset body request tidak didukung' },
  ],
  ['request.aborted', { status: 400, message: 'Body request tidak lengkap atau dibatalkan' }],
  ['request.size.invalid', { status: 400, message: 'Body request tidak lengkap atau dibatalkan' }],
]);

function getBodyParserError(err: unknown): { status: number; message: string } | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const type = (err as { type?: unknown }).type;
  return typeof type === 'string' ? BODY_PARSER_ERRORS.get(type) : undefined;
}

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

  const bodyParserError = getBodyParserError(err);
  if (bodyParserError) {
    res.status(bodyParserError.status).json({
      success: false,
      message: translateMessage(bodyParserError.message, locale),
    });
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
