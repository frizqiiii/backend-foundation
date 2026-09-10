import { redisClient } from '../config/redis';
import { logger } from '../logger';
import { withLock } from '../concurrency/distributed-lock';
import { getOrSetCache, invalidateCache } from '../utils/cache';

/**
 * Cache Manager (Phase 14 — Enterprise Scalability) — LAPISAN DI ATAS
 * `shared/utils/cache.ts`, BUKAN penggantinya. `getOrSetCache`/
 * `invalidateCache`/`invalidateByPattern` di file itu TETAP dipakai
 * apa adanya di seluruh codebase yang sudah memakainya
 * (`FeatureFlagService`, `TenantService`, dst) — modul ini menambah
 * DUA kapabilitas yang tidak dibutuhkan SEMUA pemanggil cache
 * sehingga tidak masuk akal dipaksakan ke primitif dasar:
 *
 * 1. **Tag-based invalidation** — satu write bisa mempengaruhi BANYAK
 *    cache key sekaligus (mis. produk baru mempengaruhi SEMUA variasi
 *    cache listing produk: per halaman, per filter kategori, dst).
 *    `invalidateByPattern` (cache.ts) menyelesaikan sebagian dari
 *    masalah ini via SCAN pola key, tapi butuh key-nya mengikuti pola
 *    string yang bisa ditebak. Tag menyelesaikan kasus yang LEBIH
 *    umum: key-key yang TIDAK berbagi pola string sama sekali tapi
 *    secara logis "milik" hal yang sama.
 * 2. **Stampede protection** — saat SATU key populer kedaluwarsa,
 *    tanpa proteksi, SEMUA request yang datang bersamaan akan
 *    sama-sama cache-miss dan sama-sama menjalankan `fetcher` (mis.
 *    query database berat) di saat yang sama — disebut "cache
 *    stampede" atau "thundering herd". Dengan distributed lock (Phase
 *    14), hanya SATU request yang benar-benar menjalankan `fetcher`;
 *    request lain menunggu sebentar lalu membaca hasil yang baru saja
 *    disimpan request pertama.
 */

function tagKey(tag: string): string {
  return `cache:tag:${tag}`;
}

/**
 * Sama seperti `getOrSetCache`, TAPI setiap `key` yang disimpan juga
 * didaftarkan ke SET Redis untuk setiap `tag` di `tags` — memungkinkan
 * `invalidateTag` di bawah menghapus SELURUH key yang pernah terdaftar
 * ke tag itu, tanpa perlu tahu daftar key-nya di muka.
 */
export async function getOrSetCacheWithTags<T>(
  key: string,
  ttlSeconds: number,
  tags: string[],
  fetcher: () => Promise<T>
): Promise<T> {
  const result = await getOrSetCache(key, ttlSeconds, fetcher);

  if (redisClient && tags.length > 0) {
    try {
      // Pipeline — mendaftarkan ke beberapa SET tag sekaligus dalam
      // SATU round-trip jaringan, bukan satu `sadd` terpisah per tag.
      const pipeline = redisClient.pipeline();
      for (const tag of tags) {
        pipeline.sadd(tagKey(tag), key);
        // TTL SET tag SEDIKIT lebih panjang dari TTL cache key-nya —
        // supaya SET tidak kedaluwarsa lebih dulu sementara key yang
        // didaftarkannya masih ada (yang akan membuat `invalidateTag`
        // tidak lagi tahu key itu perlu dihapus).
        pipeline.expire(tagKey(tag), ttlSeconds + 60);
      }
      await pipeline.exec();
    } catch (error) {
      logger.warn(
        { err: error, key, tags },
        'CacheManager: gagal mendaftarkan key ke tag — cache tetap tersimpan, hanya invalidasi-by-tag untuk key ini yang tidak akan berfungsi'
      );
    }
  }

  return result;
}

/**
 * Menghapus SELURUH cache key yang pernah didaftarkan ke `tag` lewat
 * `getOrSetCacheWithTags`, PLUS SET tag itu sendiri (supaya tidak
 * menyisakan SET kosong/basi di Redis selamanya).
 */
export async function invalidateTag(tag: string): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    const keys = await redisClient.smembers(tagKey(tag));
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
    await redisClient.del(tagKey(tag));
  } catch (error) {
    logger.warn({ err: error, tag }, 'CacheManager: gagal invalidasi tag');
  }
}

/** Lama request lain menunggu (dan berapa kali mencoba baca ulang)
 * sebelum menyerah dan menjalankan `fetcher`-nya SENDIRI — jaring
 * pengaman kalau request yang memegang lock ternyata gagal/lambat
 * sekali, supaya request lain tidak menunggu selamanya. */
const STAMPEDE_WAIT_RETRY_MS = 100;
const STAMPEDE_MAX_WAIT_RETRIES = 20; // total ~2 detik

/**
 * Sama seperti `getOrSetCache`, TAPI saat cache MISS, request lain
 * yang cache-miss BERSAMAAN untuk `key` yang SAMA akan menunggu satu
 * sama lain (lewat distributed lock) alih-alih semuanya menjalankan
 * `fetcher` secara paralel. Dipakai untuk cache yang: (a) dibaca
 * SANGAT sering (traffic tinggi di key yang sama), DAN (b) `fetcher`-
 * nya cukup mahal/berat sehingga menjalankannya berkali-kali
 * bersamaan benar-benar berdampak (query agregat berat, panggilan API
 * eksternal, dst) — untuk cache biasa yang `fetcher`-nya murah,
 * `getOrSetCache` polos sudah cukup; overhead koordinasi lock di sini
 * tidak sepadan untuk kasus itu.
 */
export async function getOrSetCacheWithStampedeProtection<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (!redisClient) {
    return fetcher();
  }

  const cached = await tryReadCache<T>(key);
  if (cached !== undefined) {
    return cached;
  }

  const lockResult = await withLock(`cache-stampede:${key}`, ttlSeconds * 1000, () =>
    getOrSetCache(key, ttlSeconds, fetcher)
  );

  if (lockResult.ran) {
    return lockResult.result;
  }

  // Lock sedang dipegang request lain yang sudah lebih dulu memproses
  // `fetcher` untuk key yang sama — tunggu sebentar sambil mencoba
  // baca ulang cache (yang akan terisi begitu request itu selesai),
  // BUKAN langsung ikut menjalankan `fetcher` sendiri (itu justru
  // meniadakan tujuan stampede protection ini).
  for (let i = 0; i < STAMPEDE_MAX_WAIT_RETRIES; i += 1) {
    await sleep(STAMPEDE_WAIT_RETRY_MS);
    const retryCached = await tryReadCache<T>(key);
    if (retryCached !== undefined) {
      return retryCached;
    }
  }

  // Request yang memegang lock ternyata tidak kunjung selesai dalam
  // batas wajar — daripada menunggu tanpa batas, jalankan `fetcher`
  // sendiri sebagai jaring pengaman terakhir (TIDAK menulis ulang ke
  // cache lewat lock — cukup kembalikan hasilnya langsung, supaya
  // tidak menambah kontensi lock lagi).
  logger.warn(
    { key },
    'CacheManager: menyerah menunggu stampede lock, menjalankan fetcher sendiri sebagai fallback'
  );
  return fetcher();
}

async function tryReadCache<T>(key: string): Promise<T | undefined> {
  if (!redisClient) {
    return undefined;
  }
  try {
    const cached = await redisClient.get(key);
    return cached !== null ? (JSON.parse(cached) as T) : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { invalidateCache };
