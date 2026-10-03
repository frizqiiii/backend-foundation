/**
 * `true` hanya kalau KITA TAHU koneksi Redis tidak siap (`status` ioredis bukan `ready`: `connecting`,
 * `reconnecting`, `end`, dst). `status` yang tidak ada (mis. mock di test) dianggap "tidak diketahui"
 * → `false`, supaya pemanggil tetap mencoba.
 *
 * Kenapa perlu: koneksi BullMQ (`queueConnection`) memakai `maxRetriesPerRequest: null` (wajib dari
 * BullMQ), jadi perintah yang dikirim saat Redis mati TIDAK PERNAH gagal — ia mengantre di offline queue
 * tanpa batas. Pemanggil yang hanya mengandalkan `try/catch` (kolektor `/metrics`, `tryEnqueue`) tidak
 * pernah terpicu dan request menggantung. Dengan mengecek status DULU, tidak ada perintah yang dikirim
 * sama sekali (jadi tidak ada yang menumpuk di offline queue, dan tidak ada job ganda saat Redis pulih).
 */
export function isRedisConnectionDown(connection: { status?: string } | null): boolean {
  return connection !== null && connection.status !== undefined && connection.status !== 'ready';
}
