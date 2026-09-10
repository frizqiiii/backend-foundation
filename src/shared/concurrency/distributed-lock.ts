import crypto from 'node:crypto';
import { redisClient } from '../config/redis';
import { logger } from '../logger';

/**
 * Distributed Lock (Phase 14 — Enterprise Scalability) — mencegah DUA
 * proses (mis. dua instance worker yang di-scale horizontal, lihat
 * `shared/scheduler/index.ts`) menjalankan operasi yang sama secara
 * bersamaan.
 *
 * IMPLEMENTASI: `SET key token NX PX ttlMs` (atomic — hanya berhasil
 * kalau key belum ada) untuk mengambil lock, Lua script untuk
 * melepaskannya (HANYA menghapus key kalau value-nya masih token yang
 * SAMA dengan yang di-set proses ini — mencegah proses A tidak sengaja
 * menghapus lock milik proses B yang mengambil alih setelah lock A
 * kedaluwarsa sendiri).
 *
 * KEJUJURAN SOAL BATASAN — ini BUKAN implementasi algoritma Redlock
 * penuh (yang mensyaratkan mayoritas dari BEBERAPA instance Redis
 * independen untuk jaminan correctness formal saat terjadi network
 * partition/failover). Implementasi di sini memakai SATU koneksi
 * Redis (`redisClient`, sama dengan yang dipakai cache) — cukup untuk
 * tujuan "kurangi kemungkinan kerja dobel" (mis. dua worker menjalankan
 * job cleanup yang sama persis di detik yang sama), TIDAK cukup untuk
 * kebutuhan yang butuh jaminan mutual-exclusion ketat secara
 * matematis (mis. mencegah double-spend finansial). Untuk kebutuhan
 * terakhir itu, evaluasi Redlock multi-instance sungguhan atau kunci
 * di level database (`SELECT ... FOR UPDATE`) sebagai gantinya.
 */

const LOCK_KEY_PREFIX = 'lock:';

/** Lua script untuk release yang aman — dijalankan ATOMIK di Redis
 * (satu operasi, tidak bisa diselingi proses lain di antara GET dan
 * DEL), memverifikasi token sebelum menghapus. Menulis ulang pola
 * "compare-and-delete" ini sebagai dua perintah terpisah (GET lalu
 * DEL) akan punya race condition: proses lain bisa mengambil lock
 * yang sama tepat di antara kedua perintah itu. */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export interface AcquireLockResult {
  acquired: boolean;
  /** Token unik lock ini — WAJIB dioper balik ke `releaseLock` oleh
   * pemanggil yang sama yang memperolehnya. */
  token?: string;
}

/**
 * Mencoba mengambil lock. TIDAK menunggu/retry — kalau lock sedang
 * dipegang proses lain, langsung mengembalikan `{ acquired: false }`.
 * Pemanggil yang butuh retry (mis. "tunggu sampai lock lain selesai")
 * memakai `withLock` di bawah, bukan memanggil ini berulang manual.
 */
export async function acquireLock(key: string, ttlMs: number): Promise<AcquireLockResult> {
  if (!redisClient) {
    // Redis tidak dikonfigurasi — TIDAK ADA cara memberi jaminan
    // exclusion lintas-proses sama sekali. Mengembalikan
    // `acquired: true` (fail-open) SENGAJA, konsisten dengan pola
    // graceful-degradation di seluruh aplikasi ini (lihat
    // `login-attempt-tracker.ts`) — deployment single-instance
    // (development, atau production yang memang belum di-scale)
    // tetap harus bisa berjalan normal tanpa Redis.
    return { acquired: true, token: 'no-redis-fallback' };
  }

  const token = crypto.randomUUID();
  const lockKey = `${LOCK_KEY_PREFIX}${key}`;

  try {
    const result = await redisClient.set(lockKey, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { acquired: true, token } : { acquired: false };
  } catch (error) {
    logger.warn(
      { err: error, key },
      'DistributedLock: gagal mengambil lock dari Redis — fail-open (dianggap berhasil)'
    );
    // Fail-open dengan alasan yang SAMA dengan `checkAccountLock` di
    // `login-attempt-tracker.ts`: Redis yang bermasalah tidak boleh
    // membuat operasi normal (mis. job scheduler) berhenti total.
    // Trade-off yang disadari: SELAMA Redis bermasalah, ada risiko
    // kerja dobel — lebih baik daripada tidak ada job yang berjalan
    // sama sekali.
    return { acquired: true, token: 'redis-error-fallback' };
  }
}

export async function releaseLock(key: string, token: string): Promise<void> {
  if (!redisClient || token === 'no-redis-fallback' || token === 'redis-error-fallback') {
    return;
  }

  try {
    await redisClient.eval(RELEASE_LOCK_SCRIPT, 1, `${LOCK_KEY_PREFIX}${key}`, token);
  } catch (error) {
    logger.warn(
      { err: error, key },
      'DistributedLock: gagal melepaskan lock — akan kedaluwarsa sendiri sesuai TTL'
    );
  }
}

/**
 * Cara pemakaian yang DIREKOMENDASIKAN — membungkus `fn` di antara
 * `acquireLock`/`releaseLock` secara otomatis (termasuk saat `fn`
 * melempar error — lock TETAP dilepaskan lewat `finally`).
 *
 * Mengembalikan `{ ran: false }` (BUKAN melempar error) kalau lock
 * sedang dipegang proses lain — pemanggil (lihat
 * `shared/scheduler/job-runner.ts`) memutuskan sendiri apa artinya
 * "tidak jalan kali ini" untuk use case masing-masing (biasanya:
 * proses lain sudah menjalankannya, aman untuk dilewati).
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const { acquired, token } = await acquireLock(key, ttlMs);
  if (!acquired || !token) {
    return { ran: false };
  }

  try {
    const result = await fn();
    return { ran: true, result };
  } finally {
    await releaseLock(key, token);
  }
}
