# Tenant Status — Suspend/Reaktivasi Tenant (item T3)

`PATCH /api/v1/tenants/:id/status` — ganti status tenant antara
`ACTIVE` dan `SUSPENDED` (nilai lain ditolak validasi, 422). Butuh
permission `tenant.manage`, sama seperti `PATCH .../plan` (item 2.11).

## Kenapa ini lebih dari sekadar tambah satu endpoint

`Tenant.status` dan enum `TenantStatus` (ACTIVE/SUSPENDED) sudah ada
sejak Phase 11 di schema, tapi endpoint untuk mengubahnya sengaja
ditunda — komentar lama di `TenantController` bilang ini "punya
implikasi lebih besar ... perlu dirancang eksplisit". Waktu
membangun endpoint ini, ternyata implikasi itu nyata: **jalur
autentikasi API key (`authenticateWithApiKey`) sama sekali tidak
pernah mengecek status tenant.** Satu-satunya tempat yang mengecek
status adalah `tenantMiddleware`, dan itu HANYA aktif kalau request
membawa header `X-Tenant-ID` — yang tidak pernah dikirim di jalur API
key (jalur itu resolve `tenantId` langsung dari `ApiKey.tenantId`).

Konsekuensinya: kalau endpoint ini dibangun apa adanya (cuma ubah
kolom `status`), tenant yang di-SUSPEND karena **nunggak tagihan** —
skenario yang disebutkan eksplisit di komentar `enum TenantStatus`
sendiri — API key partner-nya akan **tetap berfungsi penuh**. Itu
bukan fitur suspend yang berguna untuk kasus penggunaan utamanya.

## Perbaikan: `shared/tenant/tenant-status.ts`

`authenticateWithApiKey` sekarang memanggil `isTenantActiveForApiKey`
SEDINI mungkin (sebelum cek kuota gateway maupun query pemilik key),
supaya request dari tenant yang suspended ditolak (403) tanpa ikut
membebani Redis (kuota) atau Postgres (`userRepository.findById`)
untuk request yang toh akan ditolak.

**Fail-CLOSED, sengaja berbeda dari `resolveTenantPlanSafe` (fail-soft)
di file sebelahnya:**
- `resolveTenantPlanSafe` fail-soft masuk akal karena efeknya cuma
  memilih tier kuota default kalau lookup gagal — konsekuensinya
  ringan.
- Status suspend adalah keputusan boleh/tidak boleh masuk. Kalau
  lookup-nya gagal dan kita anggap "aktif" secara default, itu
  membuka celah PERSIS di skenario yang ingin dicegah SUSPENDED
  (bypass pembekuan akses saat ada gangguan database/cache).
- Risiko praktis dari fail-closed ini kecil: `userRepository.findById`
  yang dipanggil tepat sesudahnya di `authMiddleware` juga TIDAK
  fail-soft, jadi outage database yang sungguh-sungguh mempengaruhi
  kedua query itu sudah menggagalkan request lewat jalur lain juga.

## Cache & invalidasi

Status di-cache per `tenantId` (`cacheKeys.tenantStatusById`, TTL 30
detik — sama seperti `tenantPlanById`), supaya jalur API key (yang
cuma tahu `tenantId`, bukan slug) tidak query Postgres di setiap
request. `TenantService.updateStatus` meng-invalidasi cache ini
(dan `tenantBySlug`) secara eksplisit begitu status berubah, supaya
suspend terasa SEGERA di kedua jalur enforcement — bukan menunggu
TTL habis.

## Audit log

Mengikuti pola T2 (audit log perubahan plan): setiap `PATCH
.../status` — termasuk yang tidak mengubah nilai (`ACTIVE ->
ACTIVE`) — dicatat sebagai audit `UPDATE` pada entity `Tenant` dengan
`details: {field: 'status', from, to}`, ikut hash chain yang sama.
Diverifikasi lewat integration test yang benar-benar memanggil
`AuditRepository.verifyChainIntegrity()` produksi.

## Verifikasi yang sudah dijalankan (sandbox)

- Unit test: `tenant.repository.spec.ts`, `tenant.service.spec.ts`
  (termasuk `isActiveById`), `tenant.controller.spec.ts`,
  `tenant-status.spec.ts` (fail-closed dibuktikan lewat mock yang
  reject), `auth.middleware.spec.ts` (tenant suspended -> 403
  SEBELUM cek kuota/query user; tenant aktif -> lanjut normal).
- Integration end-to-end BARU (`app.tenant-status-audit.integration.spec.ts`,
  7 test): `PATCH /api/v1/tenants/:id/status` dijalankan sebagai satu
  kesatuan lewat `supertest` (auth JWT asli, RBAC asli, Prisma
  di-mock) — pertama kali endpoint ini pernah dijalankan utuh. Audit
  log yang ditulis LULUS `verifyChainIntegrity()` produksi asli.
- `tsc --noEmit`, `lint:ci`, seluruh `npx jest`: **159 suite / 1302
  test lolos** (naik dari 158/1295... dari 157/1277 sebelum T3),
  nol regresi.

## Batas yang BELUM diverifikasi (butuh environment kamu)

- `npx prisma migrate` — TIDAK ADA migration baru untuk fitur ini
  (kolom `status`+enum sudah ada sejak Phase 11), jadi tidak ada yang
  perlu di-apply, tapi tetap perlu `npx tsc --noEmit` setelah
  `prisma generate` di komputer kamu untuk memastikan.
- Belum diuji dengan Postgres+Redis sungguhan: apakah suspend lewat
  endpoint ini benar-benar memblokir panggilan API key nyata dalam
  hitungan detik (bukan cuma lolos mock).
- Cakupan enforcement TIDAK diperluas ke luar jalur API key —
  `tenantMiddleware` (jalur header `X-Tenant-ID`) sudah menegakkan
  status sejak sebelumnya, tidak disentuh di sini. Kalau ada jalur
  akses tenant LAIN yang belum diaudit (di luar API key dan header
  X-Tenant-ID), itu di luar cakupan T3 ini.
