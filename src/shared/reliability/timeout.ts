/**
 * Timeout Policy (Phase 18 — Enterprise Reliability).
 *
 * SEMUA panggilan ke service eksternal (`fetch` di provider
 * `shared/integrations/*`) sebelumnya TIDAK PUNYA batas waktu sama
 * sekali — kalau provider pihak ketiga hang (bukan error, sekadar
 * tidak pernah merespons), request/job yang memanggilnya akan
 * menggantung TANPA BATAS, menahan slot concurrency (worker/request
 * handler) selamanya. `withTimeout` memberi batas waktu KERAS lewat
 * `AbortController` — begitu timeout tercapai, `fn` diberi sinyal
 * abort (kalau ia meneruskan `signal` ke `fetch`, koneksi TCP-nya
 * ikut ditutup, bukan cuma promise-nya "dibiarkan" tetap berjalan di
 * background).
 */
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label}: timeout setelah ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (error) {
    // `fetch` yang di-abort melempar `DOMException` bernama
    // `AbortError` — dicek lewat `controller.signal.aborted` (BUKAN
    // instanceof) supaya tetap bekerja walau `fn` bukan `fetch`
    // (mis. panggilan lain yang menghormati AbortSignal dengan cara
    // berbeda).
    if (controller.signal.aborted) {
      throw new TimeoutError(label, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
