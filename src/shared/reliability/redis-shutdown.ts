import { logger } from '../logger';

/**
 * Batas waktu `quit()` saat shutdown. Harus JAUH di bawah `SHUTDOWN_TIMEOUT_MS` (default 10000ms)
 * supaya satu koneksi Redis yang macet tidak menghabiskan seluruh jatah graceful shutdown.
 */
export const REDIS_QUIT_TIMEOUT_MS = 2000;

interface QuittableRedis {
  quit: () => Promise<unknown>;
  disconnect: () => void;
}

/**
 * Menutup satu koneksi Redis saat shutdown tanpa pernah menggagalkan ataupun menahan shutdown.
 *
 * Redis (cache `redisClient` maupun BullMQ `queueConnection`) adalah dependency OPSIONAL di seluruh
 * aplikasi ini, jadi prinsip yang sama berlaku saat shutdown. Ada DUA cara `quit()` bisa bermasalah
 * kalau Redis tidak terjangkau:
 *
 * 1. Koneksi sudah menyerah/terputus → `quit()` MELEMPAR "Connection is closed." (sudah ditangani
 *    sebelumnya: dicatat sebagai warning, bukan kegagalan shutdown).
 * 2. Koneksi BullMQ (`maxRetriesPerRequest: null`, wajib dari BullMQ) MASIH mencoba tersambung dan
 *    sudah punya perintah yang mengantre di offline queue (mis. `ping()` dari `/ready` atau kolektor
 *    `/metrics`) → `QUIT` ikut mengantre DI BELAKANGNYA dan TIDAK PERNAH selesai. Tanpa batas waktu,
 *    shutdown menunggu sampai `forceExitTimer` (10 detik) lalu `process.exit(1)` — padahal HTTP server
 *    dan database sudah tertutup dengan bersih. Dibuktikan di runtime: tanpa request ke `/ready`
 *    shutdown `exit=0` dalam ~4ms; setelah SATU request `/ready` (Redis mati) → `exit=1` setelah 10s.
 *
 * Kalau `quit()` tidak selesai dalam `timeoutMs`, koneksi diputus PAKSA (`disconnect()`: hentikan
 * reconnect dan lepas socket) dan shutdown lanjut. Perintah yang masih mengantre memang hilang, tapi
 * proses akan berhenti sebentar lagi, dan data cache/antrean memang tidak bergantung pada `QUIT`.
 */
export async function quietRedisQuit(
  label: 'cache' | 'queue',
  client: QuittableRedis | null,
  timeoutMs: number = REDIS_QUIT_TIMEOUT_MS
): Promise<void> {
  if (!client) return;

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.quit(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`quit() tidak selesai dalam ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    logger.warn(
      { err: error },
      `Gagal quit koneksi Redis (${label}) dengan bersih — kemungkinan sudah terputus atau macet, koneksi diputus paksa (tidak menggagalkan shutdown)`
    );
    client.disconnect();
  } finally {
    clearTimeout(timer);
  }
}
