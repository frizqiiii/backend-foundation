import type { Request, Response } from 'express';

/**
 * Fase 2 (item 2.13 — i18n) — locale yang didukung untuk pesan
 * respons API. `id` adalah DEFAULT dan bahasa sumber semua pesan di
 * kode: header `Accept-Language` yang tidak ada, tidak dikenal, atau
 * tidak bisa dibaca SELALU jatuh ke `id`, jadi klien lama (dan seluruh
 * test yang meng-assert teks Indonesia) tidak terpengaruh.
 */
export type Locale = 'id' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['id', 'en'];
export const DEFAULT_LOCALE: Locale = 'id';

export function isLocale(value: unknown): value is Locale {
  return value === 'id' || value === 'en';
}

// Batas pemrosesan: header dari luar tidak dipercaya panjangnya.
const MAX_HEADER_LENGTH = 1024;

/**
 * Memilih locale dari header `Accept-Language` (RFC 9110 §12.5.4):
 * daftar tag dipisah koma dengan bobot `q` opsional. Aturan:
 *  - hanya SUBTAG UTAMA yang dipakai (`en-US`, `en-GB` -> `en`; `id-ID` -> `id`);
 *  - bobot tertinggi menang; bobot sama -> yang lebih dulu disebut;
 *  - `q=0` berarti "tidak diinginkan" dan diabaikan;
 *  - `*` dan bahasa yang tidak didukung diabaikan (bukan error);
 *  - tidak ada yang cocok -> `DEFAULT_LOCALE`.
 * Tidak pernah melempar error, apa pun isi headernya.
 */
export function resolveLocale(header: string | string[] | undefined): Locale {
  if (!header) {
    return DEFAULT_LOCALE;
  }
  const raw = (Array.isArray(header) ? header.join(',') : header).slice(0, MAX_HEADER_LENGTH);

  let bestLocale: Locale | null = null;
  let bestQuality = 0;

  for (const part of raw.split(',')) {
    const [tagPart, ...params] = part.trim().split(';');
    const tag = tagPart.trim().toLowerCase();
    if (!tag || tag === '*') {
      continue;
    }

    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9]*\.?[0-9]+)\s*$/i.exec(param);
      if (match) {
        quality = Number(match[1]);
      }
    }
    if (!(quality > 0)) {
      continue;
    }

    const primary = tag.split('-')[0];
    const locale = SUPPORTED_LOCALES.find((supported) => supported === primary);
    if (locale && quality > bestQuality) {
      bestLocale = locale;
      bestQuality = quality;
    }
  }

  return bestLocale ?? DEFAULT_LOCALE;
}

/**
 * Locale untuk sebuah response. Membaca `res.locals.locale` yang
 * diisi `localeMiddleware`; kalau tidak ada (mis. `res` tiruan di unit
 * test, atau kode yang berjalan sebelum middleware terpasang) jatuh ke
 * `DEFAULT_LOCALE`. DEFENSIF terhadap `res.locals` yang tidak ada.
 */
export function getResponseLocale(res: Response): Locale {
  const locale = (res.locals as Record<string, unknown> | undefined)?.locale;
  return isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/**
 * Locale untuk error handler: pakai hasil `localeMiddleware` kalau
 * ada, kalau tidak baca `Accept-Language` dari request langsung
 * (error bisa dilempar sebelum middleware sempat berjalan).
 */
export function getRequestLocale(req: Request, res: Response): Locale {
  const fromLocals = (res.locals as Record<string, unknown> | undefined)?.locale;
  if (isLocale(fromLocals)) {
    return fromLocals;
  }
  return resolveLocale(req.headers?.['accept-language']);
}
