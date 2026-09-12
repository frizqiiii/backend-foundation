/**
 * `policies.ts` sebelumnya TIDAK PUNYA spec sama sekali — file ini
 * murni objek data statis (preset `ResilientCallOptions` per
 * kategori dependency), jadi tanpa assertion yang mencocokkan angka
 * PERSIS, mutant yang mengubah angka apa pun (mis. `timeoutMs: 5000`
 * jadi `5001`, atau `attempts: 3` jadi `4`) lolos begitu saja —
 * ditemukan lewat mutation testing (Fase 1 item 1.2): mutation score
 * 33.33% sebelum spec ini ada.
 *
 * Setiap angka di sini SENGAJA diuji satu-satu (bukan cuma
 * `toMatchObject` longgar) supaya presisi tiap preset benar-benar
 * tervalidasi — angka-angka ini punya alasan desain spesifik (lihat
 * komentar di `policies.ts`), jadi kalau berubah tanpa sengaja,
 * seharusnya test ini yang pertama kali gagal.
 */
import {
  NOTIFICATION_PROVIDER_POLICY,
  PAYMENT_PROVIDER_POLICY,
  WEBHOOK_DELIVERY_POLICY,
} from './policies';

describe('policies', () => {
  describe('NOTIFICATION_PROVIDER_POLICY', () => {
    it('timeout PENDEK (5 detik) — HTTP request tidak boleh menggantung menunggu notifikasi', () => {
      expect(NOTIFICATION_PROVIDER_POLICY.timeoutMs).toBe(5_000);
    });

    it('retry PALING AGRESIF dari 3 preset (attempts:3) — notifikasi aman diulang berkali-kali', () => {
      expect(NOTIFICATION_PROVIDER_POLICY.retry).toEqual({
        attempts: 3,
        baseDelayMs: 300,
        maxDelayMs: 2_000,
      });
    });

    it('circuit breaker & bulkhead PALING LONGGAR dari 3 preset (volume notifikasi tertinggi)', () => {
      expect(NOTIFICATION_PROVIDER_POLICY.circuitBreaker).toEqual({
        failureThreshold: 5,
        resetTimeoutMs: 30_000,
      });
      expect(NOTIFICATION_PROVIDER_POLICY.bulkhead).toEqual({
        maxConcurrent: 20,
        maxQueue: 50,
      });
    });
  });

  describe('PAYMENT_PROVIDER_POLICY', () => {
    it('timeout LEBIH PANJANG dari notifikasi (10 detik, bukan 5)', () => {
      expect(PAYMENT_PROVIDER_POLICY.timeoutMs).toBe(10_000);
    });

    it('retry LEBIH SEDIKIT dari notifikasi (attempts:2, bukan 3) — cegah transaksi dobel', () => {
      expect(PAYMENT_PROVIDER_POLICY.retry).toEqual({
        attempts: 2,
        baseDelayMs: 500,
        maxDelayMs: 2_000,
      });
    });

    it('bulkhead JAUH LEBIH SEMPIT dari notifikasi (maxConcurrent:5, bukan 20)', () => {
      expect(PAYMENT_PROVIDER_POLICY.circuitBreaker).toEqual({
        failureThreshold: 3,
        resetTimeoutMs: 60_000,
      });
      expect(PAYMENT_PROVIDER_POLICY.bulkhead).toEqual({
        maxConcurrent: 5,
        maxQueue: 20,
      });
    });
  });

  describe('WEBHOOK_DELIVERY_POLICY', () => {
    it('retry.attempts PERSIS 1 (SENGAJA tanpa retry inner — retry sudah di level BullMQ)', () => {
      expect(WEBHOOK_DELIVERY_POLICY.retry).toEqual({ attempts: 1, baseDelayMs: 0 });
    });

    it('timeout, circuit breaker, bulkhead tetap terpasang meski retry inner ditiadakan', () => {
      expect(WEBHOOK_DELIVERY_POLICY.timeoutMs).toBe(10_000);
      expect(WEBHOOK_DELIVERY_POLICY.circuitBreaker).toEqual({
        failureThreshold: 5,
        resetTimeoutMs: 60_000,
      });
      expect(WEBHOOK_DELIVERY_POLICY.bulkhead).toEqual({
        maxConcurrent: 10,
        maxQueue: 100,
      });
    });
  });

  it('ketiga preset punya timeoutMs yang BERBEDA secara sengaja (menutup mutant yang menukar angka antar-preset)', () => {
    const timeouts = [
      NOTIFICATION_PROVIDER_POLICY.timeoutMs,
      PAYMENT_PROVIDER_POLICY.timeoutMs,
      WEBHOOK_DELIVERY_POLICY.timeoutMs,
    ];

    expect(timeouts).toEqual([5_000, 10_000, 10_000]);
  });

  it('retry.attempts menurun dari notifikasi (3) -> payment (2) -> webhook (1), sesuai filosofi desain di komentar', () => {
    expect([
      NOTIFICATION_PROVIDER_POLICY.retry.attempts,
      PAYMENT_PROVIDER_POLICY.retry.attempts,
      WEBHOOK_DELIVERY_POLICY.retry.attempts,
    ]).toEqual([3, 2, 1]);
  });
});
