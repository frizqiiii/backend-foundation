import type { ResilientCallOptions } from './resilient-call';

/**
 * Preset `ResilientCallOptions` per KATEGORI dependency eksternal
 * (Phase 18) — dikelompokkan berdasarkan karakteristik beban kerja,
 * BUKAN satu preset generik untuk semua. Angka-angka ini adalah
 * default yang masuk akal, bukan hasil load-testing sungguhan
 * terhadap provider sungguhan — sengaja dijadikan satu tempat (bukan
 * disebar hardcoded di tiap provider) supaya mudah disetel ulang
 * kalau ada data produksi nyata nanti.
 */

/**
 * Provider notifikasi (email/SMS/push) — dipanggil SINKRON dari alur
 * kritis user (register, forgot-password) saat Redis/BullMQ tidak
 * dikonfigurasi (lihat `enqueueEmailJob` fallback). Timeout relatif
 * PENDEK (5 detik) — request HTTP yang menunggu ini tidak boleh
 * terasa "menggantung" bagi user, lebih baik gagal cepat lalu
 * pemanggil (`AuthService`) tetap melanjutkan proses inti (akun tetap
 * dibuat) meski notifikasinya gagal terkirim.
 */
export const NOTIFICATION_PROVIDER_POLICY: ResilientCallOptions = {
  timeoutMs: 5_000,
  retry: { attempts: 3, baseDelayMs: 300, maxDelayMs: 2_000 },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  bulkhead: { maxConcurrent: 20, maxQueue: 50 },
};

/**
 * Payment provider — beda karakteristik dari notifikasi: retry LEBIH
 * SEDIKIT (2, bukan 3) karena mengulang panggilan "buat transaksi
 * pembayaran" yang gagal ambigu (mis. timeout SETELAH request
 * sampai ke Stripe, respons saja yang tidak kembali) berisiko
 * membuat transaksi dobel kalau tidak hati-hati — retry agresif
 * lebih berbahaya di sini daripada di notifikasi. Bulkhead JAUH
 * lebih sempit (5, bukan 20) — volume pembayaran wajar jauh lebih
 * rendah dari notifikasi, dan setiap slot yang "macet" di sini lebih
 * mahal untuk diperbolehkan menumpuk.
 */
export const PAYMENT_PROVIDER_POLICY: ResilientCallOptions = {
  timeoutMs: 10_000,
  retry: { attempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
  circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 60_000 },
  bulkhead: { maxConcurrent: 5, maxQueue: 20 },
};

/**
 * Webhook delivery — SENGAJA `retry.attempts: 1` (tidak ada retry
 * inner sama sekali). Beda dari 2 preset di atas: webhook SUDAH
 * punya retry di level BullMQ job (`defaultJobOptions.attempts: 5`,
 * lihat `webhook-delivery.queue.ts`) dengan backoff dalam hitungan
 * MENIT — menambah retry inner beberapa detik lagi di sini hanya
 * akan memperlambat setiap job attempt tanpa manfaat nyata (job yang
 * gagal toh akan di-retry BullMQ beberapa menit lagi). Timeout,
 * circuit breaker, dan bulkhead TETAP dipasang — itu melindungi hal
 * yang BullMQ attempts tidak lindungi (worker tidak hang menunggu
 * satu endpoint yang macet, dan tidak membombardir endpoint yang
 * sudah terbukti down berkali-kali berturut-turut).
 */
export const WEBHOOK_DELIVERY_POLICY: ResilientCallOptions = {
  timeoutMs: 10_000,
  retry: { attempts: 1, baseDelayMs: 0 },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 60_000 },
  bulkhead: { maxConcurrent: 10, maxQueue: 100 },
};
