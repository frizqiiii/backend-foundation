# Security Guide

Ringkasan SELURUH lapisan keamanan yang ada di proyek ini, dikumpulkan
jadi satu tempat untuk audit/review — masing-masing diimplementasikan
di modul yang berbeda, sengaja ditautkan di sini biar tidak perlu
menelusuri kode untuk tahu "apa saja yang sudah ada".

## Autentikasi

| Lapisan | Implementasi | Lokasi |
|---|---|---|
| Password hashing | bcrypt, `BCRYPT_SALT_ROUNDS` (default 10) | `auth.service.ts` |
| Password policy | min length, uppercase, lowercase, angka (special char SENGAJA tidak wajib — lihat catatan di bawah) | `auth.dto.ts` |
| JWT access token | HS256, expiry pendek (`JWT_EXPIRES_IN`, default 1 hari) | `shared/utils/jwt.ts` |
| Refresh token rotation | token baru setiap refresh, token lama langsung di-revoke | `auth.service.ts` |
| Reuse detection | token lama dipakai lagi → seluruh **family**-nya dicabut (Phase 9) | `auth.repository.ts` |
| Token blacklist | access token yang di-logout tidak bisa dipakai lagi meski belum expired | `shared/utils/token-blacklist.ts` |
| Account lockout | N percobaan gagal → kunci sementara dengan unlock timer | `shared/security/login-attempt-tracker.ts` |
| OAuth | Google & GitHub, opsional per provider | `auth.service.ts` |
| MFA (TOTP) — Phase 12 | authenticator app (Google Authenticator, dst) + 8 recovery code sekali-pakai | `modules/auth/mfa.service.ts` |
| API Key — Phase 12 | prefix `bfk_`, hash SHA-256, scope ⊆ permission role pemilik saat dibuat | `modules/api-keys/api-key.service.ts` |

**Kenapa password policy tidak mewajibkan special character** —
keputusan sadar mengacu ke [NIST SP 800-63B](https://pages.nist.gov/800-63-3/sp800-63b.html),
yang justru merekomendasikan panjang password di atas kompleksitas
karakter (special character memaksa pola predictable seperti
`Password1!`, bukan benar-benar lebih aman).

## Otorisasi

RBAC berbasis kode (`ROLE_PERMISSIONS`), diterapkan lewat
`requirePermission()` middleware. Lihat `docs/sequence-diagrams.md`
§2 untuk alur lengkapnya, dan `docs/architecture.md` untuk alasan
kenapa berbasis kode bukan tabel database.

## Transport & Network

- HTTPS wajib di production — Nginx + Let's Encrypt (`deploy/nginx/`,
  auto-renewal via Certbot systemd timer).
- Rate limiting **dua lapis**: Nginx (`limit_req_zone`, defense in
  depth di depan aplikasi) + `express-rate-limit` di level aplikasi
  (limit lebih ketat khusus `/auth/*`).
- Helmet — security header standar (`X-Frame-Options`, dst) di level
  aplikasi; HSTS ditambahkan terpisah di level Nginx.
- CORS — whitelist eksplisit lewat `CORS_ALLOWED_ORIGINS`, tidak
  pernah wildcard di production.
- Database & Redis **tidak dipublish** ke luar `backend-network` di
  `docker-compose.prod.yml` — hanya bisa diakses dari service lain
  di jaringan Docker yang sama.

## Validasi & Input

Seluruh input divalidasi lewat skema Zod di `<modul>.dto.ts` sebelum
menyentuh Service — termasuk file upload (tipe MIME & ukuran maksimum
di `upload.middleware.ts`).

## Observability Keamanan

- `AuditLog` — mencatat aksi sensitif (create/update/delete,
  login/logout gagal & berhasil) dengan `ipAddress`/`userAgent`.
- Sentry — error tracking real-time (opsional, `SENTRY_DSN`).
- Bull Board dashboard (`/admin/queues`) **hanya terpasang** kalau
  kredensial basic-auth diisi eksplisit — default OFF karena payload
  job bisa berisi data user (Phase 10 upgrade).

## Dependency & Supply Chain

- `npm audit --audit-level=high` di setiap CI run (Phase 13).
- Trivy image scan (CRITICAL/HIGH) di setiap build Docker image
  (Phase 13).
- GitHub Dependency Review di setiap Pull Request (Phase 13).

## Checklist Keamanan Sebelum Production

Lihat `deploy/README.md` §9 — checklist go-live lengkap (env secret,
firewall, CORS, cron backup, SSL auto-renewal).

## Phase 12 — Enterprise Security

### Multi-Factor Authentication (MFA/TOTP)

- Standar TOTP (RFC 6238) lewat `otplib` — kompatibel dengan Google
  Authenticator, Authy, 1Password, dst.
- Setup **dua langkah** (`POST /auth/mfa/setup` → `POST
  /auth/mfa/confirm`) — `mfaEnabled` baru jadi `true` setelah kode
  pertama benar-benar terverifikasi, mencegah user terkunci dari
  akunnya sendiri karena salah setup authenticator app. Lihat
  komentar lengkap di `MfaService.beginSetup`.
- 8 recovery code sekali-pakai diterbitkan saat konfirmasi berhasil,
  di-hash dengan bcrypt (bukan dienkripsi — beda dari secret TOTP,
  recovery code hanya perlu dibandingkan, tidak pernah dibaca ulang
  apa adanya), ditampilkan **satu kali saja**.
- Login untuk user ber-MFA jadi dua langkah: `POST /auth/login`
  (password) → `{ mfaRequired: true, challengeToken }` → `POST
  /auth/mfa/verify-login` (challengeToken + kode TOTP/recovery).
  `challengeToken` adalah JWT terpisah berumur 5 menit, TIDAK
  membawa hak akses apa pun (lihat `MfaChallengePayload` di
  `shared/utils/jwt.ts`).
- Menonaktifkan MFA (`POST /auth/mfa/disable`) wajib re-autentikasi
  pakai **password**, bukan kode TOTP — supaya user yang kehilangan
  akses ke authenticator app-nya tetap bisa menonaktifkan MFA.

### Encryption Service (Column Encryption)

- AES-256-GCM (`shared/security/encryption.service.ts`) — dipakai
  untuk `User.mfaSecret` (secret TOTP HARUS bisa dibaca ulang apa
  adanya, jadi dienkripsi dua-arah, bukan di-hash satu-arah seperti
  password).
- Auth tag GCM membuat ciphertext yang diubah gagal didekripsi
  dengan jelas (bukan menghasilkan plaintext rusak diam-diam).
- **Secret rotation preparation**: `ENCRYPTION_KEY_PREVIOUS` (pola
  identik `JWT_SECRET_PREVIOUS`) — data lama tetap bisa didekripsi
  selama masa transisi setelah `ENCRYPTION_KEY` diganti. Rotasi:
  pindahkan key lama ke `ENCRYPTION_KEY_PREVIOUS`, isi
  `ENCRYPTION_KEY` dengan key baru, deploy, lalu re-enkripsi data
  lama secara bertahap (job re-encryption belum diimplementasikan di
  fase ini — data lama tetap valid dibaca lewat fallback key lama
  sampai eksplisit ditulis ulang).

### API Key Management

- Format `bfk_<64 hex char>` (32 byte acak) — prefix memudahkan
  secret-scanning tool mendeteksi kalau key tidak sengaja ter-commit.
- Disimpan sebagai **hash SHA-256** (bukan bcrypt) — API key sudah
  bertentropi tinggi (dibuat lewat CSPRNG, bukan dipilih manusia),
  jadi tidak butuh cost-factor lambat ala bcrypt; SHA-256 juga
  memungkinkan lookup `O(1)` lewat unique index, yang tidak mungkin
  dengan bcrypt.
- `scopes`: kosong = mewarisi seluruh permission role pemilik
  **saat key dibuat**; diisi eksplisit = WAJIB subset permission
  tersebut (`ApiKeyService.resolveScopes`, `ForbiddenError` kalau
  melebihi).
- `authMiddleware` mendeteksi prefix `bfk_` di header
  `Authorization: Bearer` dan mendelegasikan ke jalur API key,
  sepenuhnya backward compatible — JWT tidak pernah berawalan
  `bfk_`, jadi tidak ada perubahan perilaku untuk client yang sudah
  ada. `requirePermission` menegakkan **irisan** permission role
  pemilik key SAAT REQUEST (bisa saja sudah berubah sejak key dibuat)
  DAN scope key itu sendiri.
- Self-service penuh — `POST/GET /api-keys`, `DELETE /api-keys/:id`,
  semua beroperasi atas `req.user.id`, tidak ada endpoint admin untuk
  mengelola API key user lain di fase ini.

### Belum ditegakkan di Phase 12 ini (disengaja, lihat juga OWASP ASVS checklist)

- **Tidak ada job re-encryption otomatis** setelah rotasi
  `ENCRYPTION_KEY` — data lama tetap terbaca lewat
  `ENCRYPTION_KEY_PREVIOUS`, tapi tidak otomatis ditulis ulang dengan
  key baru.
- **API key milik user yang di-soft-delete tidak otomatis
  ter-revoke** — `authenticateWithApiKey` menolaknya di request-time
  (`NotFoundError`, pemilik tidak ditemukan), tapi baris `ApiKey`-nya
  sendiri tetap ada di database sampai dibersihkan manual.
- **Tidak ada rate limiting khusus** untuk percobaan kode
  MFA/recovery — endpoint `/auth/mfa/*` mengikuti rate limit umum
  `authRateLimiter` (lihat `app.ts`), belum ada limit KHUSUS per
  percobaan kode yang lebih ketat.
- **API key tidak mendukung IP allowlist / scoping per-endpoint** di
  luar `scopes` berbasis permission — fitur granular tambahan untuk
  fase berikutnya kalau dibutuhkan.

## Session Management & Audit (Phase 17)

- **Active Sessions/Device Management** — `GET /auth/sessions`
  menampilkan seluruh sesi aktif (device/browser/OS diparsing dari
  User-Agent, IP address, `isCurrent` flag). `RefreshToken` per baris
  MERUPAKAN representasi satu sesi — TIDAK ada tabel `UserSession`
  terpisah (lihat rationale di `prisma/schema.prisma`).
- **Session Revocation** — `DELETE /auth/sessions/:id` (satu device)
  dan `DELETE /auth/sessions` (semua device) — KEDUANYA sekarang
  tercatat ke `AuditLog` (`SESSION_REVOKED`/`SESSIONS_REVOKED_ALL`,
  ditambahkan Phase 17 — sebelumnya kedua aksi ini TIDAK diaudit sama
  sekali, gap yang sudah diperbaiki).
- **Login History** (`GET /auth/login-history`) sekarang mencakup
  LOGIN/LOGOUT/LOGIN_FAILED **dan** SESSION_REVOKED/SESSIONS_REVOKED_ALL
  — satu riwayat keamanan akun yang lengkap, bukan endpoint terpisah
  per jenis aksi.

## Enterprise Reliability sebagai Lapisan Keamanan (Phase 18)

Beberapa pattern Phase 18 punya nilai keamanan langsung, bukan cuma
reliability:

- **Rate Limit per Tenant** (`shared/security/rate-limiter.ts`) —
  lapisan TAMBAHAN di atas rate limit per-IP yang sudah ada,
  mencegah SATU tenant (mis. API key bocor) menghabiskan kapasitas
  yang dipakai bersama tenant lain, walau menyebar lewat banyak IP.
- **Circuit Breaker** pada seluruh panggilan provider eksternal
  (`shared/reliability/`) — mencegah SATU provider yang down/lambat
  membuat proses API/worker kehabisan resource menunggu
  (denial-of-service tidak sengaja terhadap diri sendiri).
- **Idempotency Key + Request Deduplication**
  (`shared/reliability/idempotency.middleware.ts`) — mencegah operasi
  non-idempotent (mis. registrasi webhook endpoint) dieksekusi dobel
  akibat retry client, dengan cache response per-user (mencegah user
  lain membaca response milik user lain lewat key yang kebetulan sama).
- **Graceful Shutdown** (`server.ts`) — mencegah request yang sedang
  diproses terputus paksa saat deploy/scale-down, yang di beberapa
  kasus (mis. transaksi payment di tengah jalan) bisa berujung state
  data yang tidak konsisten kalau proses mati mendadak.
