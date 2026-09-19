import type { NextFunction, Request, Response } from 'express';
import { resolveLocale } from './locale';

/**
 * Fase 2 (item 2.13 — i18n) — menentukan locale request dari
 * `Accept-Language`, menyimpannya di `res.locals.locale` (dibaca
 * `sendSuccess`, `errorHandler`, dan middleware yang membalas langsung),
 * dan menandai response:
 *  - `Content-Language` — bahasa `message` pada body.
 *  - `Vary: Accept-Language` — body BERBEDA per header ini, jadi cache
 *    bersama (CDN/proxy) tidak boleh menyajikan satu bahasa ke semua
 *    orang. Tanpa ini, respons yang di-cache untuk klien `en` bisa
 *    sampai ke klien `id`.
 * Dipasang di level `app` (bukan hanya `/api/v1`) supaya error yang
 * dilempar middleware global (CORS, CSRF, tenant) ikut bertutur dalam
 * bahasa yang sama.
 */
export function localeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const locale = resolveLocale(req.headers['accept-language']);
  res.locals.locale = locale;
  res.setHeader('Content-Language', locale);
  res.vary('Accept-Language');
  next();
}
