# Changelog

Semua perubahan penting pada project ini dicatat di sini. Format mengikuti
[Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/); pembagian
"breaking" vs "aditif" untuk API publik mengikuti `docs/api-versioning.md`
(bagian 2.1) — perubahan aditif tetap di `/api/v1` dan dicatat di sini, perubahan
breaking butuh versi mayor baru.

Belum ada rilis bertag; seluruh perubahan di bawah ada di **[Belum dirilis]**.
Ringkasan ini disusun per item roadmap (Fase 2 dan sesudahnya); riwayat commit
per commit ada di `git log`. Tidak semua item tercatat dengan detail yang sama —
untuk rincian teknis dan batasannya, buka dokumen yang disebutkan di tiap baris.

## [Belum dirilis]

### Ditambahkan
- **Multi-tenancy Row-Level Security** di level database (item 2.1): isolasi tenant
  ditegakkan Postgres, bukan hanya kode aplikasi; ada jalur test terpisah
  (`npm run test:rls`).
- **Audit log tak-terubah** berbasis hash-chain (item 2.2) — `docs/audit-log-immutability.md`.
- **Kebijakan retensi data dan penghapusan data user** ala GDPR (item 2.3) —
  `docs/data-retention-policy.md`.
- **Secrets management** dengan sinkronisasi dari Vault (item 2.4) —
  `docs/secrets-management.md`.
- **SBOM dan penandatanganan image** (item 2.5) — `docs/sbom-and-signing.md`.
- **SSO enterprise** berbasis OIDC per tenant.
- **Drill Disaster Recovery** (item 2.6), **chaos engineering** untuk Redis (item 2.7),
  **deployment blue-green/canary** (item 2.8), dan **audit HPA** (item 2.9) — dokumennya
  masing-masing ada di `docs/`.
- **API Gateway edge**: kuota per API key partner (item 2.10) — `docs/api-gateway.md`.
- **Rate limit per-tier/plan** (item 2.11): kolom `Tenant.plan`
  (`FREE`/`PRO`/`ENTERPRISE`, default `PRO`), kuota per-tenant dan per-API-key mengikuti
  plan, dan endpoint `PATCH /api/v1/tenants/:id/plan` (butuh `tenant.manage`) —
  `docs/rate-limit-tiers.md`. Migration `20260919000000_tenant_plan_rate_limit_tiers`.
- **Dokumentasi strategi versioning API** (item 2.12) — `docs/api-versioning.md`.
- **i18n pesan respons API** (item 2.13): field `message` (error, sukses, dan pesan validasi) mengikuti
  `Accept-Language` — `id` (default, perilaku lama tidak berubah) dan `en`. Respons kini membawa
  `Content-Language` dan `Vary: Accept-Language`. Katalog terjemahan dijaga oleh test kelengkapan yang
  gagal kalau ada pesan tanpa terjemahan — `docs/i18n.md`.
- **Workflow `mutation.yml`**: mutation testing penuh mingguan, terpisah dari CI utama
  dan tidak memblokir PR (item 3.5).
- `CODEOWNERS` (item 3.2) dan berkas `CHANGELOG.md` ini (item 3.4).

### Diubah
- Kuota per-tenant dan per-API-key tidak lagi satu angka flat: sekarang bergantung plan
  tenant. Tier `PRO` (default, dan fallback untuk plan tak dikenal) memakai angka flat
  lama, jadi tenant yang sudah ada tidak terpengaruh.
- `createRateLimiter` menerima `max` berupa fungsi per-request dan opsi
  `skipSuccessfulRequests`/`requestWasSuccessful`.
- `ApiKeyService.authenticate` kini juga mengembalikan `tenantId`.
- Skor mutation testing dinaikkan menjadi 91,35% pada run penuh terakhir
  (`export.ts` mendapat test posisi kolom dan warna PDF).

### Diperbaiki
- **Limiter per-IP tidak lagi membatasi trafik API key yang sah** (temuan T1): request
  yang sudah diautentikasi penuh lewat API key valid dan lolos kuota per-key dikecualikan
  dari batas 300 request/15 menit per IP, sehingga tier tinggi bisa tercapai dari satu IP.
  Trafik JWT/anonim, API key palsu, dan key yang melampaui kuota tetap terhitung. Batas
  sisa: sekitar 300 request konkuren per IP — lihat `docs/rate-limit-tiers.md`.
