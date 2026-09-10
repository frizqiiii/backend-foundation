# Integrations Guide (Phase 15 — Enterprise Integration)

Abstraction layer untuk seluruh integrasi pihak ketiga aplikasi ini.
Pola SERAGAM di semua provider (kecuali Webhook Engine, lihat bagian
sendiri di bawah):

```
interface XProvider { ... }          // kontrak — SATU-SATUNYA yang boleh diketahui pemanggil
logXProvider                          // default — mencatat ke log, TIDAK memanggil vendor apa pun
xVendorProvider                       // implementasi sungguhan, lewat fetch, TANPA SDK vendor
index.ts (factory)                    // memilih berdasarkan env, fallback ke log kalau kredensial kosong
```

Ganti provider HANYA lewat environment variable (`*_PROVIDER`) — TIDAK
PERNAH dengan mengedit kode pemanggil. Menambah provider baru berarti
menambah SATU file implementasi baru + satu baris di `index.ts`
masing-masing folder, kode pemanggil (`AuthService`, dst) tidak pernah
disentuh.

**Kenapa `fetch` langsung, bukan SDK vendor** — dijelaskan di setiap
file provider, ringkasnya: menghindari menambah 5+ dependency npm
vendor berbeda (risiko konflik versi, seperti yang terjadi dengan
OpenTelemetry di Phase 13) hanya untuk satu panggilan HTTP yang
sebenarnya sederhana untuk sebagian besar vendor modern (REST + Bearer
token). Trade-off yang disadari: kehilangan fitur SDK resmi (retry
bawaan, type safety penuh, dukungan resmi vendor) — evaluasi ulang
kalau kebutuhan produksi sungguhan butuh fitur itu.

## Email — `shared/integrations/email/`

`EMAIL_PROVIDER=log|resend`. `log` (default) mencatat ke Pino. `resend`
butuh `RESEND_API_KEY`. Dipakai lewat `shared/utils/mailer.ts`
(TIDAK BERUBAH bentuknya sejak sebelum Phase 15 — backward compatible
penuh untuk `AuthService`/`email.queue.ts` yang sudah memakainya).

## SMS — `shared/integrations/sms/`

`SMS_PROVIDER=log|twilio`. `twilio` butuh
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`.

## Push Notification — `shared/integrations/push/`

`PUSH_PROVIDER=log|fcm`. `fcm` butuh `FCM_SERVER_KEY`.

**KETERBATASAN YANG DIKETAHUI**: memakai FCM legacy server-key API
(deprecated Google sejak Juni 2024), BUKAN HTTP v1 (yang butuh OAuth2
service account — di luar cakupan "satu panggilan fetch"). Untuk
production sungguhan, ganti implementasi `fcm-push.provider.ts` dengan
SDK `firebase-admin` resmi TANPA perlu mengubah `PushProvider`
interface atau pemanggilnya — itulah inti dari abstraction layer ini.

## Payment — `shared/integrations/payment/`

`PAYMENT_PROVIDER=log|stripe`. `stripe` butuh `STRIPE_SECRET_KEY`.

**KETERBATASAN YANG DIKETAHUI**: hanya `createPaymentIntent`.
Konfirmasi pembayaran (webhook Stripe masuk), refund, dan dispute
BELUM diimplementasikan — kandidat kerja lanjutan.

## Search Engine — `shared/integrations/search/`

`SEARCH_PROVIDER=postgres|meilisearch`. `postgres` (default) TIDAK
butuh infrastruktur tambahan — didukung tabel `SearchDocument`
(migrasi Phase 15), pencarian lewat `ILIKE` (bukan full-text search
sungguhan, lihat catatan lengkap keterbatasan di
`postgres-search.provider.ts`). `meilisearch` butuh
`MEILISEARCH_HOST` (+ `MEILISEARCH_API_KEY` opsional) — TIDAK ada
fallback diam-diam ke `postgres` kalau Meilisearch tidak terjangkau;
kegagalan koneksi akan terlihat jelas sebagai error, bukan
tersembunyi.

**Belum diintegrasikan ke modul manapun** — `searchProvider` adalah
primitif baru yang tersedia; menghubungkan `ProductService`/
`EventService` untuk meng-index dokumen saat create/update/delete
adalah pekerjaan lanjutan (lihat pola `upsert`/`deleteDocument` di
interface `SearchProvider`).

## Object Storage — `shared/integrations/storage/`

`OBJECT_STORAGE_PROVIDER=s3|local`. `s3` (default) — implementasi
yang sudah ada sejak Phase 4, sekarang di balik interface
`ObjectStorageProvider`. `local` menyimpan ke disk (`LOCAL_STORAGE_DIR`)
dan men-serve lewat rute static `/local-uploads` — **HANYA untuk
development lokal**, TIDAK untuk production (filesystem ephemeral di
kebanyakan platform container/serverless, dan tidak konsisten lintas
instance kalau di-scale horizontal, lihat Phase 14).

`UploadService` (modul `upload`) sudah memakai abstraksi ini — tidak
ada perubahan perilaku untuk `OBJECT_STORAGE_PROVIDER=s3` (default).

## Webhook Engine — `shared/integrations/webhook/` + `modules/webhooks/`

BEDA dari provider lain di atas — ini BUKAN "ganti vendor eksternal",
tapi fitur aplikasi ini sendiri: mengirim notifikasi event KELUAR ke
URL pihak ketiga yang didaftarkan user.

**Alur pemakaian**:
1. User mendaftarkan endpoint: `POST /api/v1/webhooks` dengan
   `{ url, eventTypes }` → mendapat `secret` (HANYA ditampilkan sekali).
2. Kode aplikasi (mis. di `ProductService.create`) memanggil
   `webhookService.trigger('product.created', productData)`.
3. `WebhookService.trigger` mencari SEMUA endpoint aktif yang
   terdaftar untuk event tersebut, mengirim payload ke masing-masing
   lewat `shared/queue/webhook-delivery.queue.ts` (antrian BullMQ
   dengan retry eksponensial 5x, sama pola dengan `email.queue.ts`).
4. Setiap payload ditandatangani HMAC-SHA256
   (`shared/integrations/webhook/webhook-signer.ts`) dengan secret
   milik endpoint tersebut. Tiga header dikirim bersama setiap
   pengiriman:
   - `X-Webhook-Signature: sha256=<hex>` — HMAC dari `${timestamp}.${rawBody}`
     (BUKAN `rawBody` saja — lihat poin berikut).
   - `X-Webhook-Timestamp` — detik Unix saat pengiriman dibuat, IKUT
     ditandatangani (bukan sekadar header polos) supaya signature+body
     lama yang disadap tidak bisa di-*replay* tanpa batas waktu
     (Finding #22, P1 Security Hardening).
   - `X-Webhook-Delivery-Id` — ID tetap yang SAMA di setiap percobaan
     retry untuk satu kejadian pengiriman yang sama (beda dari
     timestamp, yang berubah tiap percobaan) — pakai ini untuk
     deduplikasi di sisi Anda kalau perlu memproses webhook secara
     idempotent.

**Kode contoh verifikasi signature di sisi penerima** (Node.js):

```js
const crypto = require('crypto');

function isValidSignature(rawBody, secret, timestamp, receivedSignature) {
  // Tolak kalau timestamp terlalu jauh dari sekarang (replay protection)
  // — 5 menit meniru konvensi Stripe, sesuaikan sesuai kebutuhan Anda.
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > 5 * 60) {
    return false;
  }

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(receivedSignature));
}

// Di handler Anda:
// const timestamp = req.headers['x-webhook-timestamp'];
// const signature = req.headers['x-webhook-signature'];
// const deliveryId = req.headers['x-webhook-delivery-id']; // untuk dedup, opsional
```

**Belum terhubung ke event bisnis manapun** — `WebhookService.trigger`
tersedia dan berfungsi penuh (diverifikasi lewat test), TAPI belum ada
satu pun `ProductService`/`EventService`/dst yang memanggilnya.
Menghubungkan operasi CRUD yang relevan ke `webhookService.trigger`
adalah langkah berikutnya yang jelas, sengaja tidak dilakukan otomatis
di fase ini supaya tidak mengubah perilaku modul yang sudah stabil
tanpa keputusan eksplisit event apa yang seharusnya memicu webhook apa.

**Endpoint self-service**: `POST/GET /api/v1/webhooks`,
`DELETE /api/v1/webhooks/:id` — semua beroperasi atas `req.user.id`,
sama pola dengan `/api/v1/api-keys` (Phase 12).
