# Rate Limit per-Tier/Plan (Kelompok 2, item 2.11)

## Masalah yang diselesaikan

Sebelum item ini, kuota rate limit berupa satu angka flat: 1000 request/15 menit
untuk SEMUA tenant, dan `API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE` untuk SEMUA API
key. Tidak ada cara membedakan tenant gratis dari tenant enterprise.

## Desain

Paket layanan disimpan di `Tenant.plan` (enum `TenantPlan`: `FREE` / `PRO` /
`ENTERPRISE`, default `PRO`). Angka kuota per plan ada di SATU tempat:
`src/shared/security/rate-limit-tiers.ts` (bukan di database — mengubah angka
tidak butuh migration).

| Plan | Per tenant / 15 menit | Per API key / menit |
|---|---|---|
| `FREE` | 200 | 60 |
| `PRO` (default) | 1000 | `API_KEY_GATEWAY_RATE_LIMIT_PER_MINUTE` (default 300) |
| `ENTERPRISE` | 5000 | 1200 |

**Backward compatible:** `PRO` memakai angka flat LAMA persis, dan itu default
kolom + fallback untuk plan yang tidak dikenal/kosong. Semua tenant yang sudah ada
berperilaku identik setelah migration — tidak ada yang tiba-tiba lebih ketat.

### Dua titik penegakan

1. **Per-tenant** — `tenantRateLimiter` (`app.ts`): `max` sekarang fungsi yang
   dievaluasi per-request dari `getTenantContext().tenantPlan`. Plan diisi oleh
   `tenantMiddleware` dari objek Tenant yang SUDAH di-resolve (dan di-cache) —
   tidak ada query database tambahan per request.
2. **Per-API-key** — `enforcePartnerApiGatewayLimit(apiKeyId, plan)`
   (`api-key-gateway.ts`): plan diambil dari tenant pemilik key
   (`ApiKey.tenantId` -> `TenantService.resolvePlanById`, di-cache 30 detik).
   Key tanpa tenant (masa transisi Phase 11) -> tier default.

### Mengganti plan tenant

`PATCH /api/v1/tenants/:id/plan` dengan body `{ "plan": "ENTERPRISE" }`, butuh
permission `tenant.manage`. Endpoint ini SENGAJA hanya mengubah `plan` — update/
suspend `status` tenant masih ditunda (implikasi ke sesi user aktif belum
dirancang, lihat `tenant.controller.ts`). Cache tenant (slug dan id) diinvalidasi
eksplisit, jadi kuota baru berlaku segera, tanpa mereset hitungan window yang
sedang berjalan (hitungan yang sama dibandingkan dengan limit yang baru).

## Kenapa `Tenant.plan`, bukan `ApiKey.tier`

Versi awal dokumen `api-gateway.md` menyebut kemungkinan `ApiKey.tier`. Dipilih
`Tenant.plan` karena: (1) paket layanan/billing adalah properti tenant, bukan
per-key; (2) satu field mengatur DUA titik penegakan (per-tenant dan per-key),
bukan dua field yang bisa tidak sinkron; (3) `tenantRateLimiter` sudah per-tenant.
**Trade-off:** semua API key satu tenant berbagi tier yang sama — kalau suatu saat
perlu key tertentu diberi kuota berbeda dari tenant-nya, itu perlu override
per-key sebagai perluasan terpisah.

## T4 — override per-API-key (perluasan yang disebut di atas)

`ApiKey.rateLimitOverridePerMinute` (nullable, default `null` — backward
compatible penuh) MENGALAHKAN angka tier plan kalau diisi, HANYA untuk kuota
per-API-key (`enforcePartnerApiGatewayLimit`) — TIDAK memengaruhi
`tenantRateLimiter` (limiter per-tenant tetap murni ikut plan tenant, tanpa
pengecualian per-key). Diset lewat `PATCH /api/v1/api-keys/:id/rate-limit-override`
(admin, permission `api-key.manage` — TERPISAH dari permission self-service
`ApiKeyController` lain, dan SENGAJA bisa menjangkau key milik user mana pun,
bukan cuma milik sendiri: memberi pengecualian kuota adalah keputusan
platform). `rateLimitOverridePerMinute: null` di body MENGHAPUS override
(kembali ke tier plan). Diambil dari row `ApiKey` yang SAMA yang sudah
di-fetch untuk validasi key saat autentikasi — TIDAK ada query/cache
tambahan untuk field ini.

Nilai `0` (seharusnya mustahil lewat DTO yang mewajibkan `.positive()`, tapi
mungkin lewat edit manual database) diperlakukan sebagai "tidak ada
override" (`||`, bukan `??`, di `enforcePartnerApiGatewayLimit`) — pertahanan
lapis kedua supaya override yang salah tidak diam-diam memblokir SELURUH
traffic satu key.

Perubahan override tercatat di audit log (`entity: 'ApiKey'`, pola sama
seperti T2/T3), termasuk untuk PATCH yang tidak mengubah nilai.

## Perilaku kegagalan (fail-soft/fail-open)

- Plan tidak dikenal/kosong (`null`, cache lama tanpa field `plan`, nilai asing)
  -> tier default (PRO), tidak pernah melempar error.
- Lookup plan gagal (DB lambat/error) di jalur API key -> `resolveTenantPlanSafe`
  mengembalikan `null` (tier default) + warning log; TIDAK menggagalkan autentikasi.
- Redis down -> perilaku fail-open yang sudah ada (`passOnStoreError: true`,
  gateway fail-open) tidak berubah.

## Batas yang perlu diketahui (jujur)

1. **Limiter per-IP dan trafik API key (temuan T1 — ditangani, lihat di bawah).**
   `generalRateLimiter` (300 request/15 menit per IP) dipasang di seluruh `/api/v1/*`,
   sebelum limiter tenant dan gateway per-API-key. Sebelum T1, terbukti lewat probe
   bahwa tenant `ENTERPRISE` dan request ber-header `Bearer bfk_...` dari SATU IP sama-sama
   mulai ditolak di request ke-301 ("dari IP ini"): tier di atas ~300 request/15 menit dan
   kuota per-key 300/menit ke atas hanya terasa kalau trafiknya datang dari BANYAK IP.
   Itu sebabnya tier `FREE` sengaja 200 (di bawah 300).

   **Penanganan T1:** request yang SUDAH diautentikasi penuh lewat API key valid DAN lolos
   kuota per-key-nya dikecualikan dari hitungan per-IP (hit-nya dikembalikan begitu
   response selesai, lewat `skipSuccessfulRequests` + `requestWasSuccessful` bawaan
   `express-rate-limit`). Untuk trafik itu pembatasnya sekarang gateway per-key.
   Kriterianya hasil autentikasi (`req.user.jti` berawalan `api-key:`), BUKAN header:
   header `Bearer bfk_...` bisa ditempel ke endpoint publik mana pun, jadi tidak boleh
   dipercaya sebagai dasar pembebasan.

   Yang TETAP terhitung penuh (perilaku lama): trafik JWT/anonim; percobaan API key
   palsu/kedaluwarsa/dicabut; header `bfk_` di endpoint publik; dan request ber-key valid
   yang DITOLAK karena melampaui kuota per-key-nya (supaya key yang menyalahgunakan kuota
   tidak bisa membebani database tanpa batas — trade-off: partner yang terus-menerus
   melampaui kuotanya bisa terkena batas per-IP, dengan pesan "dari IP ini", sampai
   jendela 15 menitnya reset).

   **Batas sisa yang jujur:** hit dihitung SAAT REQUEST MASUK dan baru dikembalikan saat
   response selesai, jadi request yang sedang berjalan tetap terhitung sementara.
   Probe dengan latensi DB 100 ms: 300 request KONKUREN dari satu IP semua lolos, tetapi
   pada burst 350 dan 500 request konkuren masing-masing 50 dan 200 ditolak oleh limiter
   per-IP. Jadi plafon per-IP untuk trafik API key kini bukan "300 request per 15 menit"
   melainkan "sekitar 300 request yang sedang berjalan bersamaan". Dengan latensi normal
   itu jauh di atas kebutuhan laju yang wajar (mis. 20 request/detik x 0,1 detik = 2
   request berjalan), tetapi burst ratusan request paralel dari satu IP (mis. `Promise.all`
   tanpa batas) masih bisa kena.
2. Header `RateLimit-*` hanya ada untuk limiter berbasis `express-rate-limit`
   (per-IP/per-tenant). Gateway per-API-key belum mengirim header kuota.
3. Perubahan plan **dicatat di audit log** (temuan T2): aksi `UPDATE` pada entity `Tenant`, dengan
   `userId` admin, IP, user-agent, dan `details` `{"field":"plan","from":...,"to":...}`. Baris itu ikut
   hash chain (`docs/audit-log-immutability.md`). Dicatat juga untuk PATCH yang tidak mengubah nilai
   (`from == to`). Batas: penulisan audit bersifat fail-open seperti semua aksi lain (kalau database audit
   gagal, plan tetap berubah dan hanya muncul log peringatan). Pembuatan tenant (`POST /tenants`) belum
   dicatat di audit log.
4. Pada deployment TANPA Redis, cache tenant tidak aktif dan limiter memakai
   `MemoryStore` per-instance — perilaku yang sama seperti limiter lain.

## Verifikasi

Diverifikasi di sandbox (Prisma Client di-generate tipe-nya saja, engine palsu;
Prisma di-mock; Redis tidak ada): `tsc --noEmit` bersih, `npm run lint:ci` bersih,
full `jest` lolos, termasuk integration test end-to-end
(`app.tenant-rate-limit.integration.spec.ts`) yang membuktikan plan mengalir dari
database -> `tenantMiddleware` -> `tenantRateLimiter`, dan
`app.api-key-ip-limit.integration.spec.ts` untuk penanganan T1 (dicek juga bahwa dua
test yang menegaskan perilaku BARU gagal kalau pengecualian dimatikan, sedangkan empat
test perilaku LAMA tetap lolos).

**BELUM diverifikasi di environment sungguhan** (butuh Postgres/Redis kamu):
`npx prisma migrate dev` dengan migration `20260919000000_tenant_plan_rate_limit_tiers`,
limiter berbasis Redis dengan plan yang berubah di tengah window, dan
`PATCH /tenants/:id/plan` terhadap database sungguhan.

**T4 (override per-key):** diverifikasi di sandbox — `tsc --noEmit` bersih,
`lint:ci` bersih, unit test repository/service/controller/`enforcePartnerApiGatewayLimit`,
plus integration test end-to-end baru
(`app.api-key-rate-limit-override-audit.integration.spec.ts`, 6 test) yang membuktikan
ADMIN bisa memberi override ke key MILIK USER LAIN, role tanpa `api-key.manage` DITOLAK
walau terhadap key MILIK SENDIRI, dan audit log "dari -> ke" tercatat lewat kode produksi.
Suite penuh **160 suite / 1328 test lolos**, nol regresi. **BELUM diverifikasi**: migration
`20260923000000_api_key_rate_limit_override` terhadap Postgres sungguhan, dan endpoint ini
terhadap database/Redis sungguhan.
