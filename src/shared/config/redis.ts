import Redis, { Cluster } from 'ioredis';
import { env } from './env';
import { logger } from '../logger';

/**
 * Redis Client sebagai singleton — `null` kalau tidak ada satu pun
 * dari `REDIS_URL`/`REDIS_CLUSTER_NODES` yang dikonfigurasi (lihat
 * env.ts: keduanya opsional, bukan wajib). Semua pemanggil (lihat
 * `shared/utils/cache.ts`) HARUS menangani kasus `null` ini — cache
 * tidak boleh jadi single point of failure untuk aplikasi yang
 * sebenarnya bisa berjalan sempurna tanpanya.
 *
 * Tipe `Redis | Cluster` (Phase 14 — Enterprise Scalability) — KEDUA
 * class ini mengimplementasikan interface command yang sama
 * (`get`/`set`/`del`/`eval`/`pipeline`/`scan`/dst, lewat mixin
 * `Commander` yang sama di ioredis), jadi seluruh pemanggil di
 * `shared/utils/cache.ts`, `shared/cache/cache-manager.ts`,
 * `shared/concurrency/distributed-lock.ts`, dan
 * `shared/security/login-attempt-tracker.ts` TIDAK PERLU tahu/peduli
 * mode mana yang sedang aktif — mereka sudah bekerja dengan tipe ini
 * tanpa perubahan apa pun.
 */
export const redisClient: Redis | Cluster | null = buildRedisClient();

function buildRedisClient(): Redis | Cluster | null {
  if (env.REDIS_CLUSTER_NODES) {
    // Redis Cluster (Phase 14) — daftar node hanyalah SEED untuk
    // menemukan topologi cluster; ioredis otomatis menemukan &
    // mengikuti node lain (termasuk saat terjadi resharding/failover)
    // lewat perintah `CLUSTER SLOTS`/`CLUSTER SHARDS` begitu terhubung
    // ke salah satu node ini.
    const nodes = env.REDIS_CLUSTER_NODES.split(',').map((entry) => {
      const [host, port] = entry.trim().split(':');
      return { host, port: Number(port) };
    });

    return new Cluster(nodes, {
      redisOptions: {
        // Sama alasannya dengan mode single-instance di bawah — cache
        // yang gagal tidak boleh membuat request HTTP menunggu lama.
        maxRetriesPerRequest: 2,
      },
    });
  }

  if (env.REDIS_URL) {
    return new Redis(env.REDIS_URL, {
      // Jangan pernah membuat request HTTP menunggu retry Redis
      // berkali-kali — maksimal 2 percobaan, lalu menyerah cepat
      // supaya `cache.ts` bisa fallback ke database tanpa membuat
      // request lambat. INI SUDAH CUKUP untuk tujuan itu — jangan
      // dicampur dengan `retryStrategy` di bawah (dua hal BEDA:
      // `maxRetriesPerRequest` = retry PER PERINTAH/command,
      // `retryStrategy` = retry KONEKSI di BACKGROUND).
      maxRetriesPerRequest: 2,
      // SEBELUMNYA `times > 2 ? null : ...` — mengembalikan `null`
      // artinya ioredis MENYERAH RECONNECT SELAMANYA setelah 2x
      // percobaan (bukan cuma per-request). Ini menyebabkan DUA
      // masalah nyata (ditemukan lewat verifikasi manual graceful
      // shutdown, P0/Fase-1 item 1.5): (1) kalau Redis mati lalu
      // hidup lagi, aplikasi TIDAK PERNAH reconnect sampai proses
      // di-restart manual — padahal cache seharusnya otomatis pulih
      // begitu Redis kembali; (2) saat ioredis menyerah, ia
      // memanggil `flushQueue()` internal yang me-reject command
      // handshake-nya SENDIRI (bukan dari kode aplikasi) dengan
      // "Connection is closed." — rejection ini TIDAK ADA yang
      // menangkap, jadi lolos jadi `unhandledRejection` di level
      // proses, yang oleh `server.ts` (P0 hardening) dianggap FATAL
      // dan mematikan SELURUH APLIKASI — padahal Redis SENGAJA
      // didesain sebagai dependency opsional (lihat komentar di atas
      // `redisClient`). Fix: JANGAN PERNAH kembalikan `null` di sini
      // — biarkan ioredis terus mencoba reconnect di background
      // dengan delay yang dibatasi (maks 1 detik), selamanya. Ini
      // TIDAK mengubah perilaku per-request (`maxRetriesPerRequest`
      // di atas tetap yang menjaga HTTP request tidak menunggu
      // lama) — murni menutup celah "menyerah permanen" ini.
      retryStrategy: (times) => Math.min(times * 200, 1000),
      lazyConnect: false,
    });
  }

  return null;
}

if (redisClient) {
  redisClient.on('error', (error) => {
    logger.warn({ err: error }, 'Redis error — cache akan di-bypass, aplikasi tetap jalan normal');
  });
}
