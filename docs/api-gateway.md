# API Gateway / BFF (Kelompok 2, item 2.10)

## Reinterpretasi untuk arsitektur monolith

Project ini monolith (satu Express app, bukan microservices) — "API
Gateway" klasik (routing antar service, transformasi protokol,
load balancing lintas service) tidak relevan secara harfiah di sini.
Mayoritas tanggung jawab gateway SUDAH melekat di app ini sendiri:
auth terpusat (`auth.middleware.ts`), rate limiting
(`rate-limiter.ts`), circuit breaker (`circuit-breaker.ts`),
observability terpusat (Prometheus, Sentry, OTel).

**BFF (Backend for Frontend)** juga sudah sebagian terpenuhi — modul
`dashboard` sudah mengagregasi beberapa sumber data (stats + audit
summary) jadi satu response untuk kebutuhan dashboard admin.

## Gap nyata yang ditemukan & ditutup

Audit menemukan SATU celah konkret: `req.user.apiKeyScopes` sudah
ada sebagai sinyal yang membedakan traffic **partner/developer
eksternal** (login lewat API key) dari traffic **user biasa** (login
lewat sesi) — tapi keduanya diperlakukan IDENTIK oleh
`rate-limiter.ts` (limit per-IP/tenant, tidak peduli jalur
autentikasinya). Tidak ada batas EDGE yang secara sadar mengontrol/
mengamati traffic partner API secara terpisah.

## Yang dibangun

`src/shared/security/api-key-gateway.ts` —
`enforcePartnerApiGatewayLimit(apiKeyId)`:
- Kuota **per API key** (bukan per-IP — satu partner bisa punya
  banyak IP/server), fixed-window 60 detik, default 300
  request/menit (`API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE`).
- Dipanggil dari SATU titik terpusat: `authMiddleware`, persis di
  jalur autentikasi API key — otomatis berlaku ke SEMUA rute yang
  mendukung API key, tanpa perlu mendaftarkan middleware baru di
  setiap file rute.
- **Fail-open** kalau Redis tidak terjangkau (pola sama dengan
  `rate-limiter.ts` lain di project ini) — satu dependency opsional
  down tidak boleh menolak seluruh traffic partner.
- Metric Prometheus baru: `partner_api_requests_total` (label
  `outcome`: allowed/rejected/allowed_no_redis/allowed_redis_error) —
  observability volume traffic partner API terpisah dari traffic
  umum, berguna untuk capacity planning & percakapan dukungan partner.

## Verifikasi nyata yang sudah dijalankan

Terhadap Redis SUNGGUHAN (bukan mock), limit diset 5/menit untuk
mempercepat pengujian:
- 5 request pertama lolos semua.
- Request ke-6 ditolak dengan pesan jelas.
- API key LAIN (belum pernah dipakai) TIDAK ikut kena limit —
  isolasi per-key terbukti benar.
- TTL yang benar-benar tersimpan di Redis dicek langsung
  (`redis-cli ttl`) — terkonfirmasi ~60 detik seperti didesain.

Plus 15/15 unit test (mocked) mencakup: window reset sekali di awal
(bukan bergeser terus), persis di batas vs melewati batas, fail-open
saat Redis error DAN saat Redis tidak dikonfigurasi sama sekali.

## Temuan audit T18: kuota API key bisa tersangkut PERMANEN tanpa TTL (sudah diperbaiki)

Verifikasi Redis di atas hanya menguji jalur normal. Audit `enforcePartnerApiGatewayLimit` dengan menyuntikkan kegagalan
menemukan cacat pada pola `INCR` lalu `EXPIRE` (hanya bila hitungan == 1): dua perintah terpisah. Kalau `EXPIRE` gagal
sekali saja (koneksi putus, failover Redis, proses mati di antara keduanya), kunci hidup TANPA TTL. Hitungannya terus naik,
tidak pernah `== 1` lagi sehingga TTL tidak pernah diset ulang, dan begitu melewati batas API key itu ditolak
**permanen** sampai ada yang menghapus kuncinya manual (`fail-open` hanya menutup kegagalan itu sekali; request berikutnya
sudah normal dan tidak ada lagi jejaknya di log).

**Terbukti di Redis 7 sungguhan** dengan fungsi asli dan satu kegagalan `EXPIRE` yang disuntikkan: sesudah 5 request
`ttl = -1` (tidak pernah kedaluwarsa); dari hitungan 299 → lolos, DITOLAK, DITOLAK, dan `ttl` tetap `-1`.

**Perbaikan:** hitungan dan TTL dibuat dalam SATU `MULTI/EXEC` atomik: `SET key 0 EX 60 NX` (membuat kunci + TTL hanya bila
belum ada; `NX` menjaga window yang berjalan tidak bergeser) lalu `INCR`. Tidak butuh `EXPIRE ... NX` (Redis ≥ 7.0). Bukti
sesudah perbaikan di Redis sungguhan dengan `EXPIRE` yang SELALU gagal: `ttl = 60`, hitungan benar, dan TTL yang
diturunkan ke 10 detik tetap 10 setelah request berikutnya (window tidak bergeser). Mengembalikan pola lama membuat tiga tes
baru gagal.

Catatan desain yang tidak diubah [dibaca]: (1) window tetap (fixed-window) mengizinkan hingga 2× kuota di sekitar batas
window; (2) kuota dicek SESUDAH `apiKeyService.authenticate` (satu query database + penulisan `lastUsedAt`), jadi request yang
melewati kuota tetap membebani database — pertimbangan yang sama dengan temuan T1.

## Hubungan dengan item 2.11 (Rate limit per-tier/plan) — SUDAH dikerjakan

Kuota per API key sekarang bergantung pada plan tenant pemilik key
(`FREE`/`PRO`/`ENTERPRISE`), bukan satu angka statis. Yang dipakai adalah
`Tenant.plan` (bukan `ApiKey.tier` seperti sempat dipertimbangkan di draf awal
dokumen ini) — alasan dan angka lengkapnya di `docs/rate-limit-tiers.md`.

## Yang belum tercakup (scope sadar)

- Tidak ada endpoint terpisah `/partner/v1/*` — API key tetap
  mengakses endpoint `/api/v1/*` yang sama dengan user biasa, cuma
  kuotanya yang beda. Memisahkan URL prefix sepenuhnya adalah
  keputusan arsitektur lebih besar, di luar scope item ini.
- Tidak ada dashboard/UI untuk partner melihat sisa kuotanya sendiri
  (header `X-RateLimit-Remaining` semacam itu) — baru penegakan +
  observability sisi server.
