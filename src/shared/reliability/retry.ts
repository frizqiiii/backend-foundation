import { logger } from '../logger';

/**
 * Retry Policy (Phase 18 — Enterprise Reliability).
 *
 * Pola SAMA dengan exponential backoff yang sudah dipakai BullMQ
 * (`email.queue.ts`: attempts + backoff eksponensial), tapi di level
 * yang BEDA — ini untuk panggilan SINKRON di dalam satu request/job
 * (mis. dua percobaan cepat dalam hitungan detik sebelum menyerah dan
 * membiarkan BullMQ yang menjadwalkan retry BERIKUTNYA dalam hitungan
 * menit). Dua lapis retry ini SENGAJA beda skala waktu, bukan
 * duplikat — lihat pemakaiannya di `resilient-call.ts`.
 */
export interface RetryOptions {
  /** Total percobaan (termasuk percobaan pertama) — `attempts: 3` = 1 percobaan awal + maksimal 2 retry. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  /** Default: semua error dianggap boleh di-retry. Kembalikan `false` untuk error yang PASTI akan gagal lagi (mis. circuit breaker terbuka, atau error validasi 4xx) — retry hanya berguna untuk kegagalan yang SEMENTARA. */
  isRetryable?: (error: unknown) => boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  label: string
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = options.isRetryable ? options.isRetryable(error) : true;
      const isLastAttempt = attempt === options.attempts;

      if (!retryable || isLastAttempt) {
        throw error;
      }

      const delay = Math.min(
        options.baseDelayMs * 2 ** (attempt - 1),
        options.maxDelayMs ?? Number.POSITIVE_INFINITY
      );
      logger.warn(
        { label, attempt, totalAttempts: options.attempts, delayMs: delay, err: error },
        `${label}: percobaan ${attempt} gagal, retry dalam ${delay}ms`
      );
      await sleep(delay);
    }
  }

  // Tidak pernah tercapai (loop di atas selalu return atau throw pada
  // percobaan terakhir) — hanya untuk memuaskan TypeScript.
  throw lastError;
}
