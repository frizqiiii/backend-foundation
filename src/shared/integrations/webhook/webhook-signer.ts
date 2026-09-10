import crypto from 'node:crypto';

/**
 * HMAC-SHA256 signing untuk payload webhook KELUAR (Phase 15) — pola
 * yang sama dipakai Stripe/GitHub/dst untuk webhook mereka: penerima
 * memverifikasi header `X-Webhook-Signature` cocok dengan HMAC dari
 * body request yang MEREKA terima sendiri (bukan mempercayai isi body
 * begitu saja), memakai `secret` yang HANYA diketahui aplikasi ini dan
 * pemilik endpoint (diberikan SEKALI saat registrasi, lihat
 * `WebhookService.register`).
 *
 * Format signature: `sha256=<hex>` — prefix algoritma disertakan
 * eksplisit (bukan hex polos) supaya penerima bisa memvalidasi
 * algoritma yang dipakai tanpa harus tahu dari dokumentasi terpisah,
 * dan supaya format ini bisa berevolusi (mis. `sha512=...`) di masa
 * depan tanpa breaking change bagi penerima yang sudah memvalidasi
 * prefix-nya.
 *
 * Finding #22 (P1 Security Hardening, Webhook Security) — `timestamp`
 * SEKARANG WAJIB, ikut ditandatangani (HMAC atas `${timestamp}.${payload}`,
 * BUKAN `payload` saja seperti sebelumnya) dan dikirim terpisah di
 * header `X-Webhook-Timestamp` (lihat `webhook-delivery.queue.ts`).
 * SEBELUMNYA signature TIDAK PERNAH kedaluwarsa — signature+body yang
 * berhasil disadap (mis. lewat logging pihak ketiga yang bocor, atau
 * endpoint penerima yang sempat dikompromikan) bisa di-*replay* KAPAN
 * SAJA di masa depan dan tetap valid selamanya, karena tidak ada
 * apa pun dalam signature yang terikat ke satu titik waktu. Mengikat
 * `timestamp` ke dalam HMAC (bukan sekadar mengirimnya sebagai header
 * terpisah yang TIDAK ditandatangani) penting — penyerang yang replay
 * body+signature LAMA tidak bisa asal comot timestamp BARU untuk lolos
 * pengecekan freshness, karena timestamp yang dikirim wajib cocok
 * dengan yang ikut dihitung ke dalam HMAC. Penerima diharapkan menolak
 * request kalau `timestamp` terlalu jauh dari waktu mereka sendiri
 * (lihat `isTimestampFresh` & contoh kode penerima di
 * `docs/integrations-guide.md`).
 */
export function signWebhookPayload(payload: string, secret: string, timestamp: number): string {
  const hmac = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Perbandingan waktu-konstan (`crypto.timingSafeEqual`) — BUKAN `===`
 * biasa. Membandingkan signature dengan `===` membocorkan lewat
 * timing SEBERAPA JAUH tebakan penyerang cocok (early-exit di
 * karakter pertama yang beda), yang secara teori memungkinkan
 * penyerang menebak signature valid byte demi byte. Dipakai di sisi
 * PENERIMA webhook (BUKAN dipanggil di aplikasi ini sendiri — ini
 * disediakan sebagai referensi/utility untuk dipakai contoh kode
 * penerima, lihat `docs/integrations-guide.md`).
 */
export function verifyWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number,
  receivedSignature: string
): boolean {
  const expected = signWebhookPayload(payload, secret, timestamp);
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(receivedSignature);

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Finding #22 — dipakai BERSAMA `verifyWebhookSignature` di sisi
 * penerima (bukan dipanggil di aplikasi ini sendiri, sama seperti
 * fungsi itu): menolak request yang `timestamp`-nya terlalu jauh dari
 * "sekarang" versi penerima — baik terlalu LAMA (indikasi *replay*
 * request lawas yang disadap) MAUPUN terlalu JAUH DI MASA DEPAN
 * (indikasi jam salah satu pihak keliru, atau percobaan
 * memanipulasi toleransi). Default 5 menit meniru konvensi Stripe.
 */
export function isTimestampFresh(
  timestamp: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 5 * 60
): boolean {
  return Math.abs(nowSeconds - timestamp) <= toleranceSeconds;
}
