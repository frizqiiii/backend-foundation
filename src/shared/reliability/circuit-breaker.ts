import { logger } from '../logger';

/**
 * Circuit Breaker (Phase 18 — Enterprise Reliability).
 *
 * State IN-MEMORY per PROSES (bukan lewat Redis) — SENGAJA, beda dari
 * `distributed-lock.ts`/rate-limiter yang memang butuh state
 * terbagi lintas instance. Circuit breaker justru masuk akal per-
 * proses: tujuannya melindungi PROSES INI dari terus-menerus
 * menunggu provider yang down (buang waktu + slot concurrency),
 * bukan koordinasi lintas instance. Kalau di-share lewat Redis,
 * SATU instance yang lambat mendeteksi provider pulih akan
 * memblokir SEMUA instance lain juga — lebih baik tiap instance
 * belajar sendiri-sendiri.
 *
 * Tiga state standar (CLOSED → OPEN → HALF_OPEN → CLOSED/OPEN):
 * - CLOSED: normal, request diteruskan apa adanya, kegagalan dihitung.
 * - OPEN: `failureThreshold` kegagalan BERUNTUN sudah tercapai —
 *   request langsung ditolak (`CircuitOpenError`) TANPA mencoba
 *   memanggil provider sama sekali, sampai `resetTimeoutMs` lewat.
 *   Inilah inti circuit breaker: berhenti membombardir provider yang
 *   sudah terbukti down, beri provider itu waktu untuk pulih.
 * - HALF_OPEN: `resetTimeoutMs` sudah lewat — SATU request
 *   percobaan diizinkan lewat untuk "menguji" apakah provider sudah
 *   pulih. Berhasil → kembali CLOSED (reset penuh). Gagal → kembali
 *   OPEN (reset timer `resetTimeoutMs` dari awal lagi).
 */
export class CircuitOpenError extends Error {
  constructor(key: string) {
    super(
      `Circuit breaker '${key}' terbuka — provider dianggap sedang down, request ditolak tanpa mencoba`
    );
    this.name = 'CircuitOpenError';
  }
}

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Breaker {
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: number;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  resetTimeoutMs: number;
}

// Map module-level — SATU state per `key` (biasanya nama provider,
// mis. "email.resend") untuk SELURUH umur proses, dibagi oleh setiap
// pemanggilan `withCircuitBreaker` dengan `key` yang sama.
const breakers = new Map<string, Breaker>();

function getBreaker(key: string): Breaker {
  let breaker = breakers.get(key);
  if (!breaker) {
    breaker = { state: 'CLOSED', consecutiveFailures: 0, openedAt: 0 };
    breakers.set(key, breaker);
  }
  return breaker;
}

export async function withCircuitBreaker<T>(
  key: string,
  fn: () => Promise<T>,
  options: CircuitBreakerOptions
): Promise<T> {
  const breaker = getBreaker(key);

  if (breaker.state === 'OPEN') {
    const elapsed = Date.now() - breaker.openedAt;
    if (elapsed < options.resetTimeoutMs) {
      throw new CircuitOpenError(key);
    }
    // `resetTimeoutMs` sudah lewat — masuk HALF_OPEN, izinkan SATU
    // percobaan lewat sebagai "probe". Transisi ini SINKRON (tidak ada
    // `await` di antara pengecekan `state` dan penulisan ulang di
    // bawah), jadi tidak butuh lock terpisah — begitu baris ini
    // dieksekusi, PEMANGGIL LAIN yang tiba setelahnya (bahkan yang
    // "bersamaan" secara logis, mis. beberapa request HTTP yang sama-
    // sama menunggu di antrian microtask) akan melihat `state`
    // sudah HALF_OPEN, bukan lagi OPEN, dan ditangani cabang `else if`
    // di bawah — BUKAN ikut lolos sebagai probe tambahan.
    breaker.state = 'HALF_OPEN';
  } else if (breaker.state === 'HALF_OPEN') {
    // P4 (Queue & Reliability) — Finding: SEBELUMNYA cabang ini tidak
    // ada sama sekali, sehingga SETIAP pemanggil yang tiba selagi satu
    // probe HALF_OPEN lain masih berjalan (belum resolve/reject) ikut
    // lolos ke `fn()` juga — bertentangan dengan desain "SATU request
    // percobaan" yang didokumentasikan di komentar module ini, dan
    // berisiko membanjiri provider yang baru saja mulai pulih dengan
    // banyak request sekaligus tepat di momen paling rentan. Sekarang
    // ditolak sebagai `CircuitOpenError` sampai probe yang sedang
    // berjalan selesai (breaker kembali ke CLOSED atau OPEN) — aman
    // dari kemungkinan macet selamanya di HALF_OPEN karena `fn()` di
    // sini SELALU dibungkus `withTimeout` oleh `resilientCall`
    // (lihat `resilient-call.ts`), jadi probe dijamin selesai dalam
    // `timeoutMs`, bukan menggantung tanpa batas.
    throw new CircuitOpenError(key);
  }

  try {
    const result = await fn();
    if (breaker.state !== 'CLOSED') {
      logger.info({ key }, `CircuitBreaker '${key}': pulih, kembali ke CLOSED`);
    }
    breaker.state = 'CLOSED';
    breaker.consecutiveFailures = 0;
    return result;
  } catch (error) {
    breaker.consecutiveFailures += 1;

    if (breaker.state === 'HALF_OPEN' || breaker.consecutiveFailures >= options.failureThreshold) {
      // Probe HALF_OPEN gagal → langsung OPEN lagi (tidak perlu
      // menghitung ulang threshold — satu kegagalan saat probe sudah
      // cukup membuktikan provider belum pulih).
      breaker.state = 'OPEN';
      breaker.openedAt = Date.now();
      logger.error(
        { key, consecutiveFailures: breaker.consecutiveFailures },
        `CircuitBreaker '${key}': terbuka setelah ${breaker.consecutiveFailures} kegagalan beruntun`
      );
    }

    throw error;
  }
}
