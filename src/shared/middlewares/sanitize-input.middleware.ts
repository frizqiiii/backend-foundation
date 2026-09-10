import type { Request, Response, NextFunction } from 'express';

/**
 * Menghapus seluruh tag HTML dari satu nilai string via regex, BUKAN
 * lewat library parser HTML (mis. `sanitize-html`) — percobaan
 * pertama memakai `sanitize-html` DIBATALKAN karena dependency
 * transitif-nya (`htmlparser2`) ber-format ESM murni yang gagal
 * di-parse Jest tanpa konfigurasi transform tambahan; menambah babel
 * hanya untuk satu middleware kecil ini adalah kompleksitas yang
 * tidak sepadan.
 *
 * Regex `<[^>]*>` cukup untuk tujuan middleware ini: field bisnis
 * (nama, judul, deskripsi singkat, dst) TIDAK PERNAH punya alasan sah
 * berisi markup HTML SAMA SEKALI (lihat komentar `sanitizeInput` di
 * bawah) — tujuannya menghilangkan KEMUNGKINAN markup tersimpan
 * mentah-mentah di database, bukan mem-parsing HTML kompleks secara
 * presisi seperti library dedicated. Byte null (`\0`) turut dihapus —
 * historisnya dipakai untuk trik "null byte injection" di beberapa
 * parser/driver lama.
 */
function sanitizeString(value: string): string {
  return (
    value
      // `<script>`/`<style>` dihapus BESERTA isinya — beda dari tag lain
      // di bawah yang isinya tetap dipertahankan (mis. `<b>Budi</b>` ->
      // `Budi`, teksnya tetap berguna). Konten di dalam kedua tag ini
      // TIDAK PERNAH berupa teks yang berguna untuk field bisnis biasa,
      // dan membiarkannya (meski tag pembungkusnya sendiri sudah
      // terhapus) hanya menyisakan sampah di data tersimpan.
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/\0/g, '')
  );
}

/**
 * Rekursif ke seluruh nilai string di dalam object/array — body
 * request bisa berupa nested object (mis. `{ address: { city: '...' } }`),
 * jadi sanitasi TIDAK BOLEH berhenti di level pertama saja.
 *
 * Tipe non-string (number, boolean, null, Date) dikembalikan apa
 * adanya — sanitasi HTML tidak relevan untuk tipe-tipe itu, dan
 * memaksa semuanya lewat `sanitizeString` hanya akan merusak nilainya
 * (mis. `sanitizeHtml(String(42))` tetap `"42"`, tapi sekarang
 * bertipe string padahal Zod schema di layer berikutnya mengharapkan
 * number).
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        sanitizeValue(val),
      ])
    );
  }
  return value;
}

/**
 * Middleware sanitasi input — dipasang SETELAH `express.json()`
 * (butuh `req.body` sudah ter-parse) dan SEBELUM validasi Zod di
 * masing-masing route. Ini lapisan pertahanan TAMBAHAN (defense in
 * depth), BUKAN pengganti validasi Zod yang sudah ada di setiap DTO —
 * Zod menegakkan BENTUK data (tipe, panjang, format), middleware ini
 * menegakkan bahwa string yang lolos validasi bentuk tidak mengandung
 * markup yang bisa dieksekusi kalau suatu saat dirender sebagai HTML
 * di sisi klien (stored XSS).
 *
 * `req.query`/`req.params` TIDAK ikut disanitasi di sini — keduanya
 * berasal dari URL yang sudah melalui `decodeURIComponent` oleh
 * Express, dan setiap Controller yang memakainya SUDAH memvalidasi
 * lewat Zod schema (mis. `listEventsQuerySchema`) sebelum dipakai;
 * menyanitasi ulang di sini berisiko mengubah nilai yang sudah lolos
 * validasi tipe (mis. UUID di `req.params.id`) tanpa manfaat
 * keamanan tambahan yang berarti.
 */
export function sanitizeInput(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  next();
}
