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

## Hubungan dengan item 2.11 (Rate limit per-tier/plan)

Modul ini SENGAJA baru menegakkan SATU angka limit statis untuk
SEMUA API key — item 2.11 (belum dikerjakan) akan membangun DI ATAS
titik terpusat yang sama ini, menambahkan limit BERBEDA per tier/plan
API key (mis. `ApiKey.tier` atau field serupa), bukan mengulang dari
nol.

## Yang belum tercakup (scope sadar)

- Tidak ada endpoint terpisah `/partner/v1/*` — API key tetap
  mengakses endpoint `/api/v1/*` yang sama dengan user biasa, cuma
  kuotanya yang beda. Memisahkan URL prefix sepenuhnya adalah
  keputusan arsitektur lebih besar, di luar scope item ini.
- Tidak ada dashboard/UI untuk partner melihat sisa kuotanya sendiri
  (header `X-RateLimit-Remaining` semacam itu) — baru penegakan +
  observability sisi server.
