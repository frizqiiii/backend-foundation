import { withTimeout } from './timeout';
import { withRetry } from './retry';
import { withCircuitBreaker, CircuitOpenError } from './circuit-breaker';
import { withBulkhead } from './bulkhead';

/**
 * Komposisi 4 pattern reliability (Phase 18) jadi SATU pemanggilan —
 * dipakai SELURUH provider `shared/integrations/*` (email/sms/push/
 * payment/webhook) untuk memanggil API pihak ketiga. Urutan
 * pembungkusan (dari luar ke dalam) SENGAJA, bukan asal:
 *
 * Bulkhead (terluar) → Retry → Circuit Breaker → Timeout (terdalam)
 *
 * - Bulkhead PALING LUAR: menolak/mengantre request SEBELUM ia
 *   sempat menyentuh circuit breaker/retry sama sekali — kalau
 *   sudah ditolak bulkhead, tidak ada gunanya lanjut ke logic lain.
 * - Retry MEMBUNGKUS circuit breaker (bukan sebaliknya): supaya
 *   breaker mencatat SETIAP percobaan individual sebagai satu
 *   kegagalan (breaker yang akurat butuh melihat kegagalan
 *   sungguhan per-attempt, bukan cuma satu "kegagalan gabungan"
 *   setelah retry habis).
 * - `CircuitOpenError` SENGAJA ditandai TIDAK boleh di-retry
 *   (`isRetryable`) — kalau breaker sudah terbuka, mengulang
 *   percobaan dalam detik yang sama hanya buang waktu, breaker tidak
 *   akan berubah status secepat itu.
 * - Timeout PALING DALAM: membatasi SETIAP percobaan individual
 *   (bukan total keseluruhan retry) — 3 percobaan dengan timeout 5
 *   detik masing-masing artinya total bisa sampai ~15 detik+delay
 *   backoff, itu pilihan sadar (retry ATTEMPTS penuh > 1 percobaan
 *   dengan window sangat panjang, supaya percobaan kedua tidak perlu
 *   menunggu sisa waktu tunggu percobaan pertama yang hang).
 */
export interface ResilientCallOptions {
  timeoutMs: number;
  retry: { attempts: number; baseDelayMs: number; maxDelayMs?: number };
  circuitBreaker: { failureThreshold: number; resetTimeoutMs: number };
  bulkhead: { maxConcurrent: number; maxQueue: number };
}

export async function resilientCall<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
  options: ResilientCallOptions
): Promise<T> {
  const attempt = () =>
    withCircuitBreaker(
      key,
      () => withTimeout((signal) => fn(signal), options.timeoutMs, key),
      options.circuitBreaker
    );

  const withRetries = () =>
    withRetry(
      attempt,
      {
        ...options.retry,
        isRetryable: (error) => !(error instanceof CircuitOpenError),
      },
      key
    );

  return withBulkhead(key, withRetries, options.bulkhead);
}

export { TimeoutError } from './timeout';
export { CircuitOpenError } from './circuit-breaker';
export { BulkheadRejectedError } from './bulkhead';
