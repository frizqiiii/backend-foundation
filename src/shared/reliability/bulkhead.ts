/**
 * Bulkhead Pattern (Phase 18 — Enterprise Reliability).
 *
 * Nama dari kompartemen kedap air di lambung kapal — satu kompartemen
 * bocor tidak menenggelamkan seluruh kapal. Diterapkan di sini:
 * dependency eksternal yang lambat/bermasalah (mis. SMS provider
 * yang tiba-tiba lambat merespons) TIDAK BOLEH menghabiskan SELURUH
 * slot concurrency proses ini hanya karena banyak request menunggu
 * provider itu bersamaan — sisa kapasitas proses harus tetap tersedia
 * untuk melayani hal lain (request ke provider LAIN, atau endpoint
 * yang tidak bergantung pada provider itu sama sekali).
 *
 * Implementasi: semaphore in-memory sederhana per `key` — maksimal
 * `maxConcurrent` pemanggilan `fn` boleh berjalan BERSAMAAN untuk key
 * yang sama; kelebihannya masuk antrian FIFO (maksimal `maxQueue`),
 * lewat dari itu langsung ditolak (`BulkheadRejectedError`) daripada
 * antrian menumpuk tanpa batas (yang pada akhirnya juga menghabiskan
 * memori proses — bulkhead yang "bocor" sendiri kalau antriannya tak
 * terbatas).
 */
export class BulkheadRejectedError extends Error {
  constructor(key: string, maxConcurrent: number, maxQueue: number) {
    super(
      `Bulkhead '${key}' penuh (maxConcurrent=${maxConcurrent}, maxQueue=${maxQueue}) — request ditolak`
    );
    this.name = 'BulkheadRejectedError';
  }
}

export interface BulkheadOptions {
  maxConcurrent: number;
  maxQueue: number;
}

interface BulkheadState {
  active: number;
  waiters: Array<() => void>;
}

const bulkheads = new Map<string, BulkheadState>();

function getState(key: string): BulkheadState {
  let state = bulkheads.get(key);
  if (!state) {
    state = { active: 0, waiters: [] };
    bulkheads.set(key, state);
  }
  return state;
}

export async function withBulkhead<T>(
  key: string,
  fn: () => Promise<T>,
  options: BulkheadOptions
): Promise<T> {
  const state = getState(key);

  if (state.active >= options.maxConcurrent) {
    if (state.waiters.length >= options.maxQueue) {
      throw new BulkheadRejectedError(key, options.maxConcurrent, options.maxQueue);
    }
    // Menunggu giliran — `resolve`-nya dipanggil di blok `finally` di
    // bawah begitu ada slot kosong (bukan polling, event-driven).
    await new Promise<void>((resolve) => {
      state.waiters.push(resolve);
    });
  }

  state.active += 1;
  try {
    return await fn();
  } finally {
    state.active -= 1;
    // Longsorkan giliran berikutnya dari antrian (kalau ada) — HARUS
    // dilakukan SETELAH `state.active -= 1` supaya penghitungan slot
    // yang dibangunkan tetap akurat.
    const next = state.waiters.shift();
    if (next) {
      next();
    }
  }
}
