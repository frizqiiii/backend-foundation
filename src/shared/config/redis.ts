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
      // Chaos engineering drill (item 2.7) menemukan MASALAH NYATA di
      // sini — `maxRetriesPerRequest: 2` (nilai lama) TIDAK berarti
      // "gagal cepat dalam hitungan milidetik" seperti yang
      // diasumsikan komentar sebelumnya: ioredis MENUNGGU siklus
      // reconnect (`retryStrategy` di bawah) sebelum menyerahkan
      // command yang gagal, dan delay reconnect itu SENDIRI membesar
      // seiring waktu. Di bawah traffic BERKELANJUTAN saat Redis mati
      // (diuji nyata: `chaos-test/run-chaos-redis.js`), command
      // KEDUA/KETIGA yang datang saat siklus reconnect sedang
      // berjalan ikut menunggu SISA delay siklus itu — latency
      // terukur membesar dari ~600ms jadi 2400ms lalu 3000ms+ command
      // demi command, BUKAN tetap cepat seperti niat aslinya. Fix:
      // `maxRetriesPerRequest: 0` — command GAGAL SEKETIKA (bukan
      // menunggu reconnect sama sekali) begitu koneksi diketahui
      // tidak siap; `retryStrategy` di bawah TETAP mengurus
      // reconnect di BACKGROUND (independen dari command mana pun).
      maxRetriesPerRequest: 0,
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
      // dengan delay TETAP (lihat komentar update di bawah),
      // selamanya.
      //
      // UPDATE (chaos engineering drill, item 2.7) — nilai lama di
      // sini (`Math.min(times * 200, 1000)`, delay MEMBESAR seiring
      // banyaknya percobaan reconnect gagal) TERBUKTI ikut memperlambat
      // command per-request, KONTRADIKTIF dengan klaim komentar lama
      // di baris ini ("tidak mengubah perilaku per-request") — diuji
      // nyata (`chaos-test/run-chaos-redis.js`, traffic HTTP
      // berkelanjutan + Redis dimatikan sungguhan): command yang
      // datang saat siklus reconnect SEDANG berjalan ikut menunggu
      // SISA delay siklus itu, jadi latency command demi command
      // MEMBESAR (~600ms → 2400ms → 3000ms+), bukan tetap cepat.
      // Fix: delay KONSTAN (tidak membesar) — reconnect tetap dicoba
      // terus-menerus tiap 200ms (bukan makin jarang), TIDAK
      // menghukum command yang kebetulan datang belakangan.
      retryStrategy: () => 200,
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
