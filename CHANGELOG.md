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

### Keamanan
- **`aquasecurity/trivy-action` di-pin ke SHA commit penuh** (temuan T10), bukan `@master`: ref yang bisa
  berubah pada scanner keamanan adalah risiko rantai pasok (insiden 2026-03-19, tag action di-force-push ke
  malware). Lihat `docs/sbom-and-signing.md`.
- **Semua action di workflow di-pin ke SHA commit penuh** (temuan T12), termasuk `appleboy/ssh-action` yang
  memegang secret SSH VPS. Penjaga `workflow-pinning.spec.ts` gagal di PR kalau ada action tidak ber-pin, dan
  `.github/dependabot.yml` (ekosistem `github-actions`) menjaga pin tetap diperbarui lewat PR.

### Diperbaiki
- **Kuota API key tidak lagi bisa tersangkut permanen tanpa TTL** (temuan T18): pola `INCR` lalu `EXPIRE` meninggalkan
  kunci tanpa TTL kalau `EXPIRE` gagal sekali (terukur di Redis 7: `ttl = -1`, lalu ditolak selamanya). Kini `MULTI/EXEC`
  atomik `SET NX EX` + `INCR`. Lihat `docs/api-gateway.md`.
- **Sinkronisasi secret dari Vault kini menulis `.env` dengan benar dan aman** (temuan T17): nilai berisi `"` atau `\`
  sebelumnya berubah diam-diam (terukur: 2 dari 10 nilai uji), `.env` dibuat berizin 0644, nama key berisi newline
  menyuntikkan baris `.env`, dan penulisan tidak atomik. Kini nilai di-encode aman (atau ditolak), izin 0600, key
  divalidasi, penulisan atomik. Lihat `docs/secrets-management.md`.
- **Kode tukar dan `state` SSO kini benar-benar sekali-pakai** (temuan T16): pola `get` lalu `del` membuat permintaan
  bersamaan sama-sama menerima token (terukur di Redis 7 sungguhan: 20 dari 20 panggilan bersamaan berhasil). Kini
  memakai `MULTI/GET/DEL/EXEC` atomik (tepat 1 dari 50). Hasil audit lengkap dan temuan yang masih terbuka
  (login CSRF, SSRF `issuerUrl`, `email_verified`) ada di `docs/sso-security-audit.md`.
- **Erasure data pribadi (item 2.3) kini benar-benar bekerja** (temuan T15). Dua cacat yang lolos dari unit test:
  (1) `PrivacyRepository.eraseUserData` menghapus 0 baris `api_keys` secara diam-diam karena `FORCE ROW LEVEL SECURITY`
  — kini memakai `withRlsBypass` dan gagal keras (rollback) kalau ada sisa baris; (2) job retensi 30 hari selalu gagal
  karena `eraseForUser` mencari akun soft-deleted lewat `findById` (memfilter `deletedAt: null`) — kini memakai
  `UserRepository.findByIdIncludingDeleted`. Lihat `docs/data-retention-policy.md`.
- **URL callback SSO dikunci sebagai kontrak eksternal** (temuan T7): test `app.sso-callback-contract.integration.spec.ts`
  memastikan path yang dikirim ke identity provider (`/api/v1/auth/sso/:tenantSlug/callback`) tidak berubah dan
  benar-benar dilayani. Mengubah/mematikannya akan membuat semua tenant SSO gagal login. Keputusan sunset v1
  (opsi A/B/C) dicatat di `docs/api-versioning.md` bagian 2.6.
- **Perubahan plan tenant kini tercatat di audit log** (temuan T2): siapa yang mengubah, kapan, dan dari plan
  apa ke plan apa. Kolom baru `audit_logs.details` (TEKS JSON, ikut hash chain hanya kalau terisi, sehingga
  hash baris lama tidak berubah). Migration `20260920000000_audit_log_details`. `TenantService.updatePlan`
  sekarang mengembalikan `{ tenant, previousPlan }`. Lihat `docs/audit-log-immutability.md`.
- **Router API versi baru terlindungi rate limit sejak dibuat** (temuan T8): `generalRateLimiter` dan
  `tenantRateLimiter` diekstrak dari `createV1Router()` ke `createApiRouter()`, titik awal wajib setiap
  router `/api/vN`. Perilaku v1 tidak berubah. Penjaga `api-router.guard.spec.ts` gagal kalau router versi
  dibuat dengan `Router()` polos. Lihat `docs/api-versioning.md` bagian 2.5.
- **CI tidak lagi mem-push dan menandatangani image pada run `pull_request`** (temuan T9): job
  `docker-build-and-scan` hanya login/push/sign/attest pada event `push` ke `main`; PR cukup build lokal,
  scan Trivy, dan SBOM. Lihat `docs/sbom-and-signing.md`.
- **Limiter per-IP tidak lagi membatasi trafik API key yang sah** (temuan T1): request
  yang sudah diautentikasi penuh lewat API key valid dan lolos kuota per-key dikecualikan
  dari batas 300 request/15 menit per IP, sehingga tier tinggi bisa tercapai dari satu IP.
  Trafik JWT/anonim, API key palsu, dan key yang melampaui kuota tetap terhitung. Batas
  sisa: sekitar 300 request konkuren per IP — lihat `docs/rate-limit-tiers.md`.
