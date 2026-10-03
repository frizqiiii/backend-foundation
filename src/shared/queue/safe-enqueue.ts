import { logger } from '../logger';
import { queueConnection } from './connection';

/**
 * Batas waktu `queue.add()` di jalur request. Cukup longgar untuk Redis sehat yang sibuk, dan jauh di
 * bawah timeout klien/ingress yang umum (30-60 detik) supaya satu dependency opsional yang mati tidak
 * menggantung HTTP request.
 */
export const ENQUEUE_TIMEOUT_MS = 2000;

interface AddableQueue<T> {
  add: (name: string, data: T) => Promise<unknown>;
}

/**
 * `true` hanya kalau KITA TAHU koneksi tidak siap (`status` ioredis bukan `ready`). `status` yang tidak
 * ada (mis. mock di test) dianggap "tidak diketahui" → tetap dicoba. (Logika yang sama dengan
 * `queue.metrics.ts`; sengaja belum dipusatkan agar PR ini tidak bersinggungan dengan perbaikan
 * `/metrics`. Gabungkan setelah keduanya ter-merge.)
 */
function isRedisConnectionDown(connection: { status?: string } | null): boolean {
  return connection !== null && connection.status !== undefined && connection.status !== 'ready';
}

/**
 * Mencoba memasukkan job ke antrean BullMQ TANPA PERNAH menahan pemanggil lebih dari `ENQUEUE_TIMEOUT_MS`.
 * Mengembalikan `true` kalau job benar-benar masuk antrean; `false` kalau pemanggil harus memakai fallback
 * sinkron yang SAMA dengan kasus "Redis tidak dikonfigurasi" (queue `null`).
 *
 * Kenapa perlu: koneksi BullMQ memakai `maxRetriesPerRequest: null` (wajib dari BullMQ), jadi saat Redis
 * mati `queue.add()` TIDAK PERNAH gagal — perintahnya mengantre di offline queue tanpa batas dan
 * `await queue.add()` menggantung. Dibuktikan di runtime: `POST /auth/register` dengan Redis mati timeout
 * 8 detik tanpa respons, padahal user SUDAH tersimpan (percobaan ulang → 409 "Email sudah terdaftar").
 * Komentar lama hanya menjamin fallback saat Redis TIDAK DIKONFIGURASI, bukan saat dikonfigurasi tapi mati.
 *
 * Dua lapis: (1) kalau koneksi diketahui tidak siap, `add()` TIDAK dipanggil sama sekali (tidak ada perintah
 * menumpuk di offline queue, tidak ada job ganda saat Redis pulih); (2) jaring pengaman timeout untuk
 * koneksi yang tampak `ready` tapi macet. Pada kasus (2) `add()` yang sudah dikirim tetap bisa selesai
 * belakangan, jadi pada jendela waktu yang sangat sempit itu satu job bisa terproses dua kali (sekali oleh
 * fallback sinkron, sekali oleh worker) — diterima: email/notifikasi berulang lebih ringan daripada
 * request yang menggantung.
 */
export async function tryEnqueue<T>(
  queue: AddableQueue<T> | null,
  name: string,
  data: T
): Promise<boolean> {
  if (!queue) return false;

  if (isRedisConnectionDown(queueConnection)) {
    logger.warn({ job: name }, 'tryEnqueue: koneksi Redis tidak siap — memakai fallback sinkron');
    return false;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      queue.add(name, data),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Enqueue job tidak selesai dalam batas waktu')),
          ENQUEUE_TIMEOUT_MS
        );
      }),
    ]);
    return true;
  } catch (error) {
    logger.warn(
      { err: error, job: name },
      'tryEnqueue: gagal memasukkan job ke antrean — memakai fallback sinkron'
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
