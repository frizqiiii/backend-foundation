import * as Sentry from '@sentry/node';
import { env } from './env';

/**
 * Inisialisasi Sentry — HARUS dipanggil paling awal, sebelum modul
 * lain (termasuk `app.ts`) di-import, supaya instrumentasi otomatis
 * Sentry (HTTP, dsb) bisa memasang hook-nya sebelum modul yang
 * relevan sempat di-require oleh Node. Lihat pemanggilannya di baris
 * pertama `server.ts`.
 *
 * Kalau `SENTRY_DSN` kosong (default), `Sentry.init` tetap aman
 * dipanggil — SDK akan diam-diam tidak mengirim apa pun ke mana pun,
 * bukan error. Ini yang membuat observability tetap "opt-in" tanpa
 * membuat startup aplikasi gagal ketika belum dikonfigurasi.
 */
export function initSentry(): void {
  Sentry.init({
    dsn: env.SENTRY_DSN || undefined,
    environment: env.NODE_ENV,
    integrations: [Sentry.expressIntegration()],
    // Tracing performa (bukan cuma error) — mulai dari sample rate
    // rendah; naikkan sesuai kebutuhan/volume trafik sungguhan.
    tracesSampleRate: env.NODE_ENV === 'production' ? 0.1 : 0,
  });
}

export { Sentry };
