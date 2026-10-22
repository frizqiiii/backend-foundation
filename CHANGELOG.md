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
- **E2E terhadap stack Compose** (`npm run test:e2e:compose`, `scripts/e2e-compose.mjs`): 16 asersi lewat HTTP terhadap
  database sungguhan di bawah role non-superuser, mengunci hasil probe S1 (header tenant terikat identitas), R15 (produk
  per tenant), R20b (eventTypes webhook), R22 (tipe export tanpa tenant) dan R23 (API key tanpa header). Berbeda dari
  `npm run test:rls` yang menguji repository, ini menguji rantai middleware. Dijalankan manual setelah
  `docker compose up -d`, dan sekarang juga job wajib di CI (`e2e-compose`, membangun stack Compose, migrate + seed). Skrip menunggu `/health` sampai 200 (default 90 detik,
  `E2E_WAIT_SECONDS`) sebelum mulai: tanpa itu, dijalankan tepat setelah `down` + `up -d` ia gagal "tidak terjangkau"
  karena aplikasi masih start.
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
- **Endpoint suspend/reaktivasi tenant** `PATCH /api/v1/tenants/:id/status` (`ACTIVE`/`SUSPENDED`, temuan T3),
  tercatat di audit log dan membersihkan cache. Temuan penting: jalur autentikasi API key **tidak pernah mengecek
  status tenant** (hanya `tenantMiddleware` lewat header `X-Tenant-ID`, yang tidak pernah dikirim jalur API key),
  jadi tenant yang di-suspend tetap bisa dipakai partner lewat API key. Kini dicek sedini mungkin dan **fail-closed**
  — `docs/tenant-status-suspension.md`.
- **Override kuota rate limit per API key** `PATCH /api/v1/api-keys/:id/rate-limit-override` (temuan T4, permission
  baru `api-key.manage`), kolom `ApiKey.rateLimitOverridePerMinute` — migration
  `20260923000000_api_key_rate_limit_override`.
- **Smoke test runtime image di CI** (hanya `pull_request`): langkah `docker-build-and-scan` kini menjalankan image
  hasil build dan memuat modul native `bcrypt`. Sebelumnya build, scan Trivy, SBOM, dan signing semuanya lolos untuk
  image yang tidak bisa dijalankan.
- **Role aplikasi PostgreSQL terpisah dari superuser** untuk stack Compose: `deploy/postgres/01-app-role.sh`,
  variabel `DB_ADMIN_PASSWORD` (wajib di `docker-compose.prod.yml`), dan `docs/postgres-roles.md` (termasuk jalur
  migrasi untuk volume yang sudah ada).
- Variabel `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `APP_HOST_PORT` untuk `docker-compose.yml` (dev).
- **Webhook kini benar-benar dipicu** (R20, #63): `ProductService` dan `EventService` memicu `product.created`,
  `product.upgraded`, `product.deleted`, `event.created`, `event.updated`, dan `event.deleted`. Payload sama dengan
  response API (untuk event hapus hanya `{ id }`). Konstanta di `src/modules/webhooks/webhook.events.ts`.

### Diubah
- **Batas coverage dinaikkan mendekati angka nyata** (`jest.config.ts`): statements 90 menjadi 96, branches 84 menjadi 88,
  functions 86 menjadi 95, lines 90 menjadi 96 (angka nyata 97.89 / 90.42 / 97.31 / 98.16). Batas lama terlalu longgar:
  cakupan bisa turun sekitar 6 sampai 11 poin tanpa CI merah.
- Kuota per-tenant dan per-API-key tidak lagi satu angka flat: sekarang bergantung plan
  tenant. Tier `PRO` (default, dan fallback untuk plan tak dikenal) memakai angka flat
  lama, jadi tenant yang sudah ada tidak terpengaruh.
- `createRateLimiter` menerima `max` berupa fungsi per-request dan opsi
  `skipSuccessfulRequests`/`requestWasSuccessful`.
- `ApiKeyService.authenticate` kini juga mengembalikan `tenantId`.
- Skor mutation testing dinaikkan menjadi **≈96,86%** pada run penuh terakhir (431 mutant, 13 survivor). Seluruh
  37 survivor dari run sebelumnya ditriase satu per satu dengan bukti nyata dan dicatat di
  `docs/mutation-survivors.md` (bug nyata diperbaiki dengan mutasi manual sebagai bukti; equivalent mutant dibuktikan
  empiris; sisanya didokumentasikan). Angka dihitung dari `mutation.json`: terdeteksi (killed + timeout) dibagi mutan valid.
- **Runtime naik dari Node 20 ke Node 24**: `Dockerfile` (`node:24-alpine`), `ci.yml`, `mutation.yml`, dan panduan
  VPS. Node 20 sudah melewati akhir masa dukungan (30 April 2026). Terverifikasi: image build di Alpine, binding
  `bcrypt`, dan server production start dengan database dan Redis; peringatan AWS SDK soal versi Node hilang.
- `package.json` memuat `allowScripts: {"bcrypt@5.1.1": true}` agar npm ≥ 12 (yang memblokir install script secara
  bawaan) tetap membangun binding native `bcrypt`.
- **`docker-compose.prod.yml` kini menolak start tanpa `DB_ADMIN_PASSWORD`** (superuser PostgreSQL, terpisah dari
  `DB_PASSWORD` milik role aplikasi). Deployment yang sudah ada perlu menambahkannya di `.env`.
- **Export tipe `AUDIT_LOG`, `SYSTEM_STATISTICS`, dan `DAILY_ACTIVE_USERS` kini ditolak (403) untuk request ber-tenant**
  (R22, #61): sumber datanya (`audit_logs`, `file_uploads`) belum punya kolom `tenant_id`, jadi hasilnya tidak bisa
  dibatasi per tenant. Export tipe lain tidak berubah.
- **Statistik dashboard, analytics, dan reporting kini dibatasi ke tenant request** (R21, #60); sebelumnya tidak
  dibatasi per tenant. Mode lintas tenant ("platform") hanya untuk `ADMIN` tanpa tenant. Bagian yang tidak punya
  `tenant_id` (audit log, upload) ditolak atau bernilai kosong (N/A) di mode tenant.
- **Daftar produk dengan tenant aktif dibaca dari primary di dalam transaksi request, tidak lagi dari read-replica**
  (R15, #62): replica tidak bisa ikut transaksi yang membawa `app.tenant_id`. Tanpa tenant, jalur lama tidak berubah.
- `WebhookRepository.findActiveByEventType(eventType)` tidak lagi menerima parameter `tenantId` (R20): tenant selalu
  diambil dari konteks request.
- **`POST /api/v1/webhooks` kini menolak (422) `eventTypes` di luar daftar yang dipicu aplikasi** (R20b): `product.created`,
  `product.upgraded`, `product.deleted`, `event.created`, `event.updated`, `event.deleted`. Sebelumnya nama bebas,
  sehingga salah ketik tersimpan dan tidak pernah cocok dengan event mana pun. Endpoint yang sudah terdaftar tidak
  diubah. Daftar juga tampil sebagai `enum` di OpenAPI.

### Keamanan
- **Header `X-Tenant-ID` kini terikat ke identitas pemanggil** (temuan S1, #58): sebelumnya user atau API key milik
  satu tenant bisa memilih tenant lain lewat header (terukur: JWT dan API key dengan `X-Tenant-ID: acme` sama-sama
  mendapat 200). Kini `assertTenantBinding` di `authMiddleware`: tenant diambil dari user (JWT) atau dari API key
  (`key.tenantId`, fallback ke tenant pemilik); user tanpa tenant hanya boleh memilih tenant kalau `ADMIN`; selain itu
  403. Endpoint publik tanpa identitas (mis. `GET /products`) tidak terpengaruh.
- **Export di worker kini dibangun di dalam scope tenant job-nya** (temuan R22, #61): export `USERS` memuat user semua
  tenant (terukur: 5 baris termasuk user tenant lain, seharusnya 3), export statistik menghitung seluruh database, dan
  `AUDIT_LOG` bersifat global. Worker tidak punya konteks tenant; kini `tenantId` dari data job dipakai
  (`ExportRepository.runInTenantScope`) dan job tanpa tenant ditolak.
- **Statistik dashboard/analytics/reporting dibatasi ke tenant request** (temuan R21, #60); akses lintas tenant hanya
  lewat mode platform untuk `ADMIN` tanpa tenant, dan `AuditRepository.findRecent` dijaga `assertPlatformScope`.
- **Cache daftar event kini memuat `tenantId`** (temuan S2, #59): sebelumnya satu kunci cache dipakai semua tenant,
  sehingga tenant lain bisa menerima daftar event yang di-cache tenant pertama selama TTL 60 detik. Tanpa konteks
  tenant tidak ada cache. Daftar produk memakai pola yang sama (R15, #62).
- **RLS kini benar-benar berlaku di stack Docker Compose**: `POSTGRES_USER=app_user` menjadikan aplikasi **superuser
  bootstrap** yang mem-bypass Row-Level Security walaupun `FORCE ROW LEVEL SECURITY` (diukur: `select count(*) from
  products` = 3 untuk superuser vs 0 untuk role biasa pada data yang sama). Berlaku untuk `docker-compose.yml` dan
  `docker-compose.prod.yml`. Kini role aplikasi dibuat terpisah (`NOSUPERUSER NOBYPASSRLS`); 28 migration terbukti
  bisa diterapkan tanpa hak superuser. Role bootstrap tidak bisa diturunkan, jadi volume yang sudah ada butuh
  dump/restore — `docs/postgres-roles.md`.
- **Port database, Redis, dan aplikasi di `docker-compose.yml` (dev) tidak lagi terbuka ke semua interface**: `'5432:5432'`
  memublikasikan ke `0.0.0.0`; kini `127.0.0.1` (terukur: lewat IP LAN ditolak). Docker menambah aturan iptables sendiri
  yang biasanya melewati firewall host.
- **Advisory dependency**: `@grpc/grpc-js` dan `brace-expansion` (HIGH) diperbaiki lewat update lockfile;
  `GHSA-vfj7-8cjw-p6xm` (`braces`, HIGH) **tidak punya versi perbaikan** (semua versi terdampak) dan hanya dependency
  development, jadi diterima di `scripts/npm-audit-allowlist.json` dengan justifikasi teknis dan tinjau ulang paling
  lambat 2027-04-01.
- **`aquasecurity/trivy-action` di-pin ke SHA commit penuh** (temuan T10), bukan `@master`: ref yang bisa
  berubah pada scanner keamanan adalah risiko rantai pasok (insiden 2026-03-19, tag action di-force-push ke
  malware). Lihat `docs/sbom-and-signing.md`.
- **Semua action di workflow di-pin ke SHA commit penuh** (temuan T12), termasuk `appleboy/ssh-action` yang
  memegang secret SSH VPS. Penjaga `workflow-pinning.spec.ts` gagal di PR kalau ada action tidak ber-pin, dan
  `.github/dependabot.yml` (ekosistem `github-actions`) menjaga pin tetap diperbarui lewat PR.

### Diperbaiki
- **API key tanpa header `X-Tenant-ID` kini berjalan di tenant milik key-nya** (R23): sebelumnya request ber-API key
  tanpa header tidak punya konteks tenant, sehingga tabel ber-RLS terlihat kosong (terukur: `GET /api-keys` dengan header
  `items=5`, tanpa header `items=0`) dan menulis data gagal dengan 500 (`POST /products`). `tenantMiddleware` kini
  memilih tenant dari `ApiKey.tenantId` ketika header tidak dikirim dan key valid; header yang dikirim tetap menang dan
  tetap diikat ke key oleh S1 (header tenant lain: 403). Key tidak dikenal, dicabut, kedaluwarsa, atau tanpa tenant tidak
  mendapat konteks tenant, dan tenant SUSPENDED ditolak 403. Biayanya satu lookup key dan satu query tenant tambahan per
  request ber-API key tanpa header.
- **Webhook tidak pernah terkirim** (R20, #63): `WebhookService.trigger()` tidak punya pemanggil di kode produksi
  (terukur: 0 job di antrean `webhook-delivery` setelah membuat/mengupgrade/menghapus produk dan membuat event; kini
  5 job dengan isolasi tenant utuh). Selain itu `trigger` melempar error kalau pencarian endpoint gagal (padahal
  dokumentasinya menjanjikan tidak pernah melempar), dan query-nya berjalan di transaksi request: query yang gagal
  membatalkan seluruh transaksi bisnis. Kini dispatch tidak ditunggu, tidak pernah melempar, dan mencari endpoint di
  transaksi tenant mandiri. Risiko yang diketahui: webhook bisa masuk antrean sebelum transaksi request ter-commit.
- **Repository tabel ber-`FORCE ROW LEVEL SECURITY` memakai koneksi tanpa `app.tenant_id`** (R15–R19, #49, #55–#57,
  #62): dengan role aplikasi non-superuser, penulisan ditolak (`42501`, HTTP 500) dan pembacaan kosong. Terukur pada
  `POST /webhooks` (500), `POST /exports` (500), dan `GET /products` (selalu kosong); mekanisme yang sama diperbaiki
  untuk events dan API key. Kini repository memakai `getScopedPrisma` (transaksi request yang membawa tenant); worker memakai transaksi mikro
  per langkah dari `tenantId` data job (`runInTenantTransaction`, `withTenantScope`). Stack Compose sebelumnya
  menyembunyikan ini karena aplikasi berjalan sebagai superuser (lihat bagian Keamanan di atas).
- **Image Docker tidak punya binding `bcrypt` dan tidak bisa menjalankan modul auth**: `npm ci --ignore-scripts` melewati
  install script bcrypt, dan tidak ada `npm rebuild`. Terbukti di `docker build` + `docker run` (`bcrypt_lib.node` tidak
  ada). Kini `npm rebuild bcrypt` di stage `deps` dan `prod-deps`; diverifikasi di Alpine.
- **Aplikasi tetap jalan saat Redis mati — kini terbukti dan diukur** (seri temuan runtime di laptop development):
  - `/ready` butuh ≈3,0 detik saat Redis mati, sama dengan `readinessProbe.timeoutSeconds: 3` Helm, sehingga probe
    bisa gagal karena dependency yang didokumentasikan opsional. Kini timeout dependency opsional 1000 ms (≈1,0 detik).
  - Shutdown menggantung 10 detik lalu keluar dengan kode 1 setelah satu request ke `/ready` atau `/metrics`
    (`QUIT` mengantre di belakang perintah yang tidak pernah selesai). Kini `quit()` dibatasi 2 detik lalu koneksi
    diputus paksa; `exit=0`.
  - `POST /auth/register` menggantung (timeout 8 detik tanpa respons) padahal user sudah tersimpan (percobaan ulang
    mendapat 409). Berlaku juga untuk reset password, kirim ulang verifikasi, notifikasi, webhook, dan export. Kini
    `tryEnqueue` memakai fallback sinkron yang sama dengan "Redis tidak dikonfigurasi".
  - Klien Redis cache membuat setiap request lewat rate limiter menunggu ≈0,59 detik (antrean offline menunggu
    siklus reconnect); kini ≈0,015 detik (`enableOfflineQueue: false`).
  - `/metrics` menggantung (metrik HTTP ikut hilang tepat saat alert dibutuhkan); kini 200 dalam ≈7 ms.
  Akar masalah yang sama: koneksi BullMQ memakai `maxRetriesPerRequest: null`, jadi perintah ke Redis yang mati
  tidak pernah gagal.
- **`prisma/seed.ts` gagal di database ber-RLS** (`42501` pada `products`, ditolak `FORCE ROW LEVEL SECURITY`) dan
  akun seed tidak bisa login (403 "Email belum diverifikasi"). Kini upsert produk/event berjalan dengan
  `app.bypass_rls` dan akun seed ditandai terverifikasi (juga pada `update`, agar database yang sudah ter-seed ikut
  terperbaiki).
- **Test PDF `export.spec.ts` gagal acak (≈4% per PDF)**: regex ekstraksi stream memakan byte deflate terakhir
  bernilai `0x0D` (terukur: 123 dari 3000 PDF vs 0). Ditambah test deterministik yang memaksa kasus itu.
- **Redis Cluster kini fail-fast** (temuan T21): command setelah seluruh node mati tidak pernah selesai (>15 detik),
  lebih buruk dari bug single-instance. Kini ditolak <1 ms dan pulih otomatis (≈258 ms) — `docs/chaos-engineering.md`.
- **Deploy blue-green kini memakai dua direktori terpisah** (temuan T20): blue dan green berbagi satu `cwd`, sehingga
  worker blue yang restart otomatis (`max_memory_restart`) menjalankan kode green yang belum lolos health check
  (dibuktikan dengan cluster PM2 sungguhan). Kini `BLUE_APP_DIR`/`GREEN_APP_DIR` wajib dan terpisah, fail-closed —
  `docs/blue-green-deployment.md`.
- **Skrip Disaster Recovery kini benar di bawah Row-Level Security** (temuan T19): `backup-db.sh` gagal dengan role aplikasi
  dan jalan pintas `--enable-row-security` menghasilkan backup KOSONG yang dinyatakan valid oleh `verify-backup.sh`;
  `verify-backup.sh` bisa menimpa production lewat URL beda ejaan (5 baris data hilang dalam uji); file backup berizin
  0644. Kini: role backup wajib `BYPASSRLS`/superuser (`BACKUP_DATABASE_URL`), pengecekan identitas database, verifikasi
  `row_security=off` dan mencakup tabel ber-RLS, izin 0600/0700, password tidak dicetak. Lihat `docs/backup-restore-guide.md`.
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
