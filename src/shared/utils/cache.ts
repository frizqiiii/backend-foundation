import { redisClient } from '../config/redis';
import { logger } from '../logger';
import { recordCacheHit, recordCacheMiss } from '../cache/cache.metrics';

/**
 * Cache-aside: coba baca dari Redis dulu; kalau tidak ada (atau Redis
 * tidak tersedia/gagal), jalankan `fetcher` (biasanya query database),
 * simpan hasilnya ke Redis untuk request berikutnya, lalu kembalikan.
 *
 * SENGAJA dibungkus try/catch di seputar SETIAP operasi Redis —
 * Redis mati/lambat TIDAK BOLEH membuat request gagal; skenario
 * terburuknya harus selalu "cache miss, baca database seperti biasa
 * tanpa cache", bukan error 500.
 *
 * Catatan penting soal tipe data: nilai yang disimpan di-serialize
 * lewat `JSON.stringify`. Field bertipe `Date` pada objek yang di-cache
 * akan kembali sebagai STRING (ISO 8601) setelah `JSON.parse`, bukan
 * instance `Date` lagi — tidak masalah untuk DTO yang hanya pernah
 * berakhir di `res.json()` (yang juga men-stringify Date dengan cara
 * yang sama), tapi WASPADA kalau nilai cache ini nanti dipakai
 * kode lain yang mengharapkan method `Date` (`.getTime()`, dst).
 */
export async function getOrSetCache<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  if (!redisClient) {
    // Redis TIDAK dikonfigurasi sama sekali — bukan "miss" dalam arti
    // cache yang tidak efektif, tapi tetap dicatat sebagai `miss`
    // supaya operator melihat di dashboard KENAPA hit ratio 0%
    // (bukan Redis mati mendadak, tapi memang tidak aktif).
    recordCacheMiss(key);
    return fetcher();
  }

  try {
    const cached = await redisClient.get(key);
    if (cached !== null) {
      recordCacheHit(key);
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    logger.warn({ err: error, key }, 'Gagal membaca cache, fallback ke database');
  }

  recordCacheMiss(key);
  const fresh = await fetcher();

  try {
    await redisClient.set(key, JSON.stringify(fresh), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn(
      { err: error, key },
      'Gagal menyimpan ke cache — data tetap dikembalikan seperti biasa'
    );
  }

  return fresh;
}

export async function invalidateCache(key: string): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    await redisClient.del(key);
  } catch (error) {
    logger.warn({ err: error, key }, 'Gagal menghapus cache');
  }
}

/**
 * Hapus semua key yang cocok dengan pola (mis. `cache:events:list:*`)
 * — dipakai ketika satu write bisa mempengaruhi BANYAK variasi cache
 * list (kombinasi filter/pagination berbeda-beda) yang tidak
 * mungkin/praktis dilacak satu per satu.
 *
 * Memakai `SCAN` (cursor, non-blocking) — BUKAN `KEYS` yang memblokir
 * seluruh Redis selama pemindaian di database besar, praktik yang
 * secara luas dianggap tidak aman untuk production.
 */
export async function invalidateByPattern(pattern: string): Promise<void> {
  if (!redisClient) {
    return;
  }

  try {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await redisClient.del(...keys);
      }
    } while (cursor !== '0');
  } catch (error) {
    logger.warn({ err: error, pattern }, 'Gagal menghapus cache berdasarkan pola');
  }
}
