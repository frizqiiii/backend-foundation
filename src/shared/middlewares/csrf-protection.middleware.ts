import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/http-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CATATAN ADAPTASI PENTING — baca sebelum mengubah file ini.
 *
 * Brief asli meminta "CSRF protection" dalam artian klasik: middleware
 * seperti `csurf` atau pola double-submit-cookie. Proteksi semacam
 * itu dirancang untuk aplikasi yang memakai SESSION COOKIE — di mana
 * browser korban OTOMATIS melampirkan cookie sesi ke request lintas-
 * origin tanpa sepengetahuan user, itulah inti serangan CSRF.
 *
 * Aplikasi ini TIDAK memakai cookie sama sekali untuk autentikasi
 * (lihat seluruh `auth.controller.ts`/`auth.dto.ts` — access token
 * dikirim lewat header `Authorization: Bearer <token>`, bukan cookie).
 * Header `Authorization` custom seperti ini TIDAK BISA dilampirkan
 * otomatis oleh form HTML lintas-origin manapun (beda dari cookie) —
 * satu-satunya cara mengirimnya adalah lewat JavaScript `fetch`/XHR
 * eksplisit, yang SUDAH ditegakkan kebijakan same-origin oleh browser
 * DAN whitelist CORS di `app.ts`. Memasang `csurf` di sini hanya akan
 * jadi kode mati yang "mengamankan" celah yang secara arsitektural
 * memang tidak ada.
 *
 * Middleware ini adalah lapisan pertahanan TAMBAHAN yang sungguhan
 * relevan untuk arsitektur Bearer-token: memverifikasi bahwa request
 * yang MENGUBAH STATE (POST/PUT/PATCH/DELETE) memang berasal dari
 * origin yang dipercaya, lewat header `Origin`/`Referer` — mengurangi
 * risiko kalau suatu saat ada endpoint yang (secara tidak sengaja atau
 * lewat perubahan arsitektur di masa depan) mulai bergantung pada
 * kredensial ambient seperti cookie.
 *
 * Request TANPA header `Origin` sama sekali (curl, aplikasi mobile,
 * server-ke-server, Postman) tetap diizinkan lewat — sama seperti
 * kebijakan CORS di `app.ts`, verifikasi Origin murni relevan untuk
 * konteks browser.
 */
export function verifyRequestOrigin(allowedOrigins: string[]) {
  return function csrfEquivalentCheck(req: Request, _res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }

    if (!allowedOrigins.includes(origin)) {
      next(new ForbiddenError(`Request lintas-origin dari "${origin}" ditolak.`));
      return;
    }

    next();
  };
}
