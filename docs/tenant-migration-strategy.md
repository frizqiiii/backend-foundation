# Tenant Migration Strategy (Phase 11 — Enterprise Architecture)

## Model isolasi yang dipilih

**Shared database, shared schema, discriminator column.** Semua
tenant berbagi satu database PostgreSQL dan satu set tabel yang sama;
isolasi ditegakkan lewat kolom `tenant_id` di tabel yang datanya
tenant-scoped (`users`, `products`, `events`).

Alternatif yang dipertimbangkan dan ditolak untuk fase ini:

| Pola | Kenapa tidak dipakai sekarang |
| --- | --- |
| Database per tenant | Butuh provisioning infra baru per tenant + `DATABASE_URL` dinamis — mengubah topologi koneksi yang sudah dipakai di seluruh Phase 1-10 |
| Schema per tenant (Postgres schema) | Migration Prisma jadi harus dijalankan berkali-kali per schema; kompleksitas operasional naik jauh lebih cepat daripada manfaat isolasinya di skala tenant yang belum besar |

Pola yang dipilih adalah yang paling murah secara operasional dan
**non-breaking** terhadap semua yang sudah dibangun — itu prioritas
eksplisit dari instruksi Phase 11 ("Semua data harus mendukung tenant
tanpa merusak project lama").

## Kenapa `tenant_id` NULLABLE, bukan NOT NULL

Ini keputusan paling penting di fase ini. `tenant_id` ditambahkan
sebagai kolom **nullable**, bukan wajib, di `User`, `Product`, `Event`.

- Baris yang sudah ada di database production (dibuat sebelum Phase
  11) di-backfill ke satu "default tenant" oleh migration
  `20260801000000_multi_tenancy_foundation` — jadi secara data,
  semuanya SUDAH punya `tenant_id` yang valid.
- Tapi kolomnya tetap nullable di level skema, supaya:
  1. Migration schema itu sendiri tidak perlu satu window yang
     memvalidasi SEMUA baris di SEMUA tabel sekaligus — backfill dan
     penegakan `NOT NULL` bisa dipisah jadi dua deploy berbeda kalau
     volume data besar.
  2. Endpoint yang belum diupdate untuk selalu mengirim tenant context
     (lihat bagian "Yang BELUM ditegakkan" di bawah) tidak tiba-tiba
     gagal insert karena constraint `NOT NULL`.

## Bagaimana tenant context mengalir

```
Request masuk
  → tenantMiddleware baca header X-Tenant-ID
      → ada & valid & ACTIVE  → runWithTenantContext({ tenantId, tenantSlug }, next)
      → tidak ada header      → runWithTenantContext({ tenantId: null }, next)   [mode transisi]
      → ada tapi invalid/SUSPENDED → 403, request berhenti di sini
  → Controller → Service → Repository
      → Repository baca getTenantContext() SAAT QUERY, bukan menerima
        tenantId sebagai parameter dari Controller
```

Tenant context disimpan lewat Node `AsyncLocalStorage`
(`shared/tenant/tenant-context.ts`), BUKAN `req.tenantId` biasa —
supaya kode yang tidak punya akses langsung ke `req` (BullMQ worker,
scheduler) tetap bisa membaca tenant yang aktif kalau di masa depan
job-job tersebut perlu tenant-aware juga.

## Mode transisi: opt-in, bukan enforced

Di Phase 11 ini, tenant scoping bersifat **opsional per request**:

- Request TANPA header `X-Tenant-ID` → berperilaku PERSIS seperti
  sebelum Phase 11 (melihat semua data lintas tenant, `tenant_id`
  baris baru = `null`).
- Request DENGAN header `X-Tenant-ID` yang valid → `ProductRepository`
  dan `EventRepository` otomatis memfilter query dengan `tenant_id`
  tersebut, dan baris baru yang dibuat otomatis diisi `tenant_id`
  tersebut.

Ini disengaja — memaksa SEMUA client mengirim header tenant di fase
yang sama dengan peletakan fondasi skema akan langsung breaking
terhadap seluruh test/integrasi/klien yang sudah ada. Rencana
mengetatkan ini jadi wajib ada di roadmap fase berikutnya (lihat
bagian "Fase lanjutan").

## Yang BELUM ditegakkan di Phase 11 ini (disengaja)

- **`UserRepository.findByEmail`/`findById` TIDAK difilter tenant.**
  `email` didesain unik secara global (bukan per-tenant), dan kedua
  method ini dipakai di jalur login/refresh token — memfilternya
  berdasarkan tenant context bisa mengunci user dari akunnya sendiri
  hanya karena request login kebetulan tidak membawa header tenant.
  Keputusan "apakah email harus unik per-tenant" ditunda ke fase
  berikutnya karena berdampak langsung ke alur `AuthService`.
- **Row-Level Security (RLS) di level PostgreSQL belum diaktifkan.**
  Isolasi saat ini sepenuhnya bergantung pada disiplin kode
  (Repository selalu menyertakan filter `tenant_id`). Ini titik
  paling rawan dari pola "discriminator column" — satu Repository baru
  yang lupa menambahkan filter tenant akan bocor data lintas tenant
  tanpa error apa pun. RLS Postgres sebagai lapisan pertahanan kedua
  (defense in depth) adalah kandidat kuat untuk fase Enterprise
  Security/Resiliency berikutnya.
- **Belum ada endpoint untuk update/suspend/delete tenant** — hanya
  `list`/`create` yang tersedia di `tenant.routes.ts`. Suspend/delete
  punya implikasi ke session user aktif milik tenant tersebut yang
  perlu dirancang eksplisit.
- **`EventRepository`/`ProductRepository` findById TIDAK difilter
  tenant** (hanya `findMany`/`create`). Idempoten dengan mode
  transisi opt-in di atas, tapi berarti kalau tenant A tahu ID
  resource tenant B, `findById` saat ini masih bisa
  mengembalikannya — Service layer di atasnya (otorisasi
  kepemilikan lewat `userId`/`ownerId`) tetap jadi lapisan pertahanan
  utama untuk saat ini.

## Fase lanjutan (di luar cakupan Phase 11)

1. Terapkan pola opt-in yang sama ke `findById` di semua repository
   tenant-scoped.
2. Ubah `tenant_id` dari opt-in menjadi WAJIB per route group (mis.
   lewat flag konfigurasi per environment), lalu akhirnya `NOT NULL`
   di skema setelah dipastikan tidak ada jalur tulis yang masih
   mengirim `null`.
3. Evaluasi row-level security PostgreSQL sebagai lapisan isolasi
   kedua.
4. Keputusan `email` unik global vs per-tenant.
5. Endpoint admin lengkap untuk lifecycle tenant (suspend/reaktivasi/
   hapus) + audit log untuk aksi tersebut (bisa memanfaatkan
   `AuditLog` yang sudah ada).

## Langkah verifikasi

Dijalankan di environment dengan PostgreSQL & Redis aktif (`docker
compose up -d` sesuai README):

```bash
npm install
npx prisma generate
npx prisma migrate dev      # menjalankan migration multi_tenancy_foundation
npm run db:seed             # membuat tenant "default" + tenant demo "acme"
npm test                    # seluruh test suite, termasuk tenant-context,
                             # tenant.middleware, TenantService
```

Verifikasi manual isolasi tenant (setelah `npm run dev`):

```bash
# Tanpa header tenant — melihat SEMUA produk lintas tenant (mode transisi)
curl http://localhost:3000/api/v1/products

# Dengan header tenant "default" — hanya produk milik tenant default
curl -H "X-Tenant-ID: default" http://localhost:3000/api/v1/products

# Dengan header tenant "acme" — hanya produk milik tenant acme
# (mis. "Monitor 27\" 144Hz" dari seed, TIDAK termasuk keyboard/mouse tenant default)
curl -H "X-Tenant-ID: acme" http://localhost:3000/api/v1/products

# Header tenant yang tidak dikenal → 403
curl -H "X-Tenant-ID: tidak-ada" http://localhost:3000/api/v1/products
```

Endpoint admin (butuh login sebagai ADMIN, lihat `docs/developer-guide.md`
untuk cara mendapatkan access token):

```bash
curl -H "Authorization: Bearer <admin_access_token>" \
     http://localhost:3000/api/v1/tenants

curl -X POST -H "Authorization: Bearer <admin_access_token>" \
     -H "Content-Type: application/json" \
     -d '{"slug":"contoso","name":"Contoso Ltd"}' \
     http://localhost:3000/api/v1/tenants
```
