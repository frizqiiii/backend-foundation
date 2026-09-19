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

## Perilaku kegagalan (fail-soft/fail-open)

- Plan tidak dikenal/kosong (`null`, cache lama tanpa field `plan`, nilai asing)
  -> tier default (PRO), tidak pernah melempar error.
- Lookup plan gagal (DB lambat/error) di jalur API key -> `resolveTenantPlanSafe`
  mengembalikan `null` (tier default) + warning log; TIDAK menggagalkan autentikasi.
- Redis down -> perilaku fail-open yang sudah ada (`passOnStoreError: true`,
  gateway fail-open) tidak berubah.

## Batas yang perlu diketahui (jujur)

1. **Limiter per-IP berjalan lebih dulu dan berlaku untuk SEMUA plan.**
   `generalRateLimiter` (300 request/15 menit per IP) dipasang di seluruh
   `/api/v1/*`, sebelum limiter tenant dan sebelum gateway per-API-key. Terbukti
   lewat probe (sandbox, Prisma di-mock): tenant `ENTERPRISE` dan request ber-header
   `Bearer bfk_...` dari SATU IP sama-sama mulai ditolak di request ke-301 dengan
   pesan "dari IP ini". Akibatnya tier di atas ~300 request/15 menit (per tenant)
   dan kuota per-key 300/menit ke atas (termasuk kuota 2.10 yang sudah ada) hanya
   terasa kalau trafiknya datang dari BANYAK IP. Itu sebabnya `FREE` sengaja 200
   (di bawah 300) — supaya tier FREE benar-benar membatasi walau dari satu IP.
   Ini perilaku warisan (bukan regresi item ini) dan dicatat sebagai temuan
   terpisah; jangan diubah diam-diam — melonggarkan per-IP untuk trafik API key
   tanpa limiter pengganti membuka kunci palsu memicu lookup DB tanpa batas.
2. Header `RateLimit-*` hanya ada untuk limiter berbasis `express-rate-limit`
   (per-IP/per-tenant). Gateway per-API-key belum mengirim header kuota.
3. Perubahan plan tidak dicatat di audit log (butuh nilai enum `AuditAction`
   baru = migration terpisah). Follow-up yang wajar untuk perubahan yang relevan
   dengan billing.
4. Pada deployment TANPA Redis, cache tenant tidak aktif dan limiter memakai
   `MemoryStore` per-instance — perilaku yang sama seperti limiter lain.

## Verifikasi

Diverifikasi di sandbox (Prisma Client di-generate tipe-nya saja, engine palsu;
Prisma di-mock; Redis tidak ada): `tsc --noEmit` bersih, `npm run lint:ci` bersih,
full `jest` 140+ suite lolos, termasuk integration test end-to-end
(`app.tenant-rate-limit.integration.spec.ts`) yang membuktikan plan mengalir dari
database -> `tenantMiddleware` -> `tenantRateLimiter`.

**BELUM diverifikasi di environment sungguhan** (butuh Postgres/Redis kamu):
`npx prisma migrate dev` dengan migration `20260919000000_tenant_plan_rate_limit_tiers`,
limiter berbasis Redis dengan plan yang berubah di tengah window, dan
`PATCH /tenants/:id/plan` terhadap database sungguhan.
