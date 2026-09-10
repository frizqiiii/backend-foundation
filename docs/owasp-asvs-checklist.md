# OWASP ASVS Checklist (Level 1/2 — Self-Assessment)

Pemetaan kontrol yang sudah ada di proyek ini ke kategori [OWASP
Application Security Verification Standard (ASVS) 4.0](https://owasp.org/www-project-application-security-verification-standard/).
Ini **self-assessment internal**, BUKAN audit resmi/sertifikasi pihak
ketiga — dipakai sebagai peta "sudah ada di mana" untuk review
selanjutnya, bukan bukti kepatuhan formal.

Legenda: ✅ ada & aktif · ⚠️ sebagian/perlu perhatian · ❌ belum ada

## V1 — Architecture, Design and Threat Modeling

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 1.1 | Dokumentasi arsitektur | ✅ | `docs/architecture.md`, `docs/erd.md`, `docs/sequence-diagrams.md` |
| 1.2 | Autentikasi terpusat, satu implementasi | ✅ | Seluruh penerbitan token lewat `AuthService.issueTokensForUser` (termasuk OAuth & MFA — lihat komentar di method itu) |
| 1.4 | Kontrol akses terpusat | ✅ | `shared/security/permissions.ts` — Role → Permission, bukan `role === 'ADMIN'` tersebar |
| 1.9 | Isolasi multi-tenant | ⚠️ | Discriminator column (Phase 11), BELUM row-level security di database — lihat `docs/tenant-migration-strategy.md` |

## V2 — Authentication

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 2.1 | Password policy (panjang, kompleksitas) | ✅ | `auth.dto.ts` — min length, huruf besar/kecil, angka |
| 2.2 | Anti-brute-force / account lockout | ✅ | `shared/security/login-attempt-tracker.ts` |
| 2.3 | MFA tersedia | ✅ | Phase 12 — TOTP + recovery code, lihat `docs/security-guide.md` |
| 2.4 | Credential storage — hash, bukan plaintext/reversible | ✅ | bcrypt untuk password & recovery code |
| 2.5 | Recovery/reset password aman | ✅ | Token sekali-pakai berumur pendek, tidak membocorkan keberadaan email (`auth.service.ts`) |
| 2.7 | Generic error message (anti user enumeration) | ✅ | "Email atau password salah" untuk kedua kasus |
| 2.8 | MFA anti-replay | ✅ | TOTP window bawaan `otplib`; recovery code sekali-pakai (`usedAt`) |
| 2.10 | Service account / API key terpisah dari user credential | ✅ | Phase 12 — `ApiKey`, hash SHA-256, scope terbatas |

## V3 — Session Management

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 3.2 | Session ID/token dengan entropi tinggi | ✅ | JWT signed HS256; refresh token via `crypto.randomBytes` |
| 3.3 | Logout benar-benar mencabut sesi | ✅ | Token blacklist (access) + revoke (refresh) |
| 3.4 | Sesi timeout (idle & absolute) | ✅ | `JWT_EXPIRES_IN` (access), refresh token TTL 7 hari |
| 3.7 | Reuse detection untuk token yang sudah di-revoke | ✅ | Refresh token family revocation (Phase 9), lihat `security-guide.md` |

## V4 — Access Control

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 4.1 | Deny by default | ✅ | `authMiddleware` di seluruh rute terproteksi |
| 4.2 | Object-level authorization (bukan cuma function-level) | ✅ | Ownership check per-resource di Service layer (mis. `EventService`, `AuthService.revokeSession`) |
| 4.3 | Admin function terpisah & diaudit | ✅ | `AuditLog`, permission `*.manage`/`*.moderate` terpisah dari permission dasar |

## V6 — Stored Cryptography

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 6.1 | Algoritma kriptografi standar, bukan buatan sendiri | ✅ | AES-256-GCM (Node `crypto` bawaan), bcrypt, HS256 |
| 6.2 | Key management — key TIDAK di-hardcode | ✅ | `ENCRYPTION_KEY`/`JWT_SECRET` dari environment variable, divalidasi panjangnya saat startup (`env.ts`) |
| 6.3 | Secret rotation didukung | ✅ | Phase 12 — `ENCRYPTION_KEY_PREVIOUS` (pola sama dgn `JWT_SECRET_PREVIOUS`) |
| 6.4 | Sensitive data at rest terenkripsi | ⚠️ | `User.mfaSecret` terenkripsi; **belum ada** column encryption untuk data sensitif lain (mis. jika suatu saat menyimpan PII tambahan) — evaluasi per-kasus di fase berikutnya |

## V7 — Error Handling and Logging

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 7.1 | Error message tidak membocorkan stack trace ke client | ✅ | Global error handler, lihat `app.ts` |
| 7.2 | Security event logging (login gagal, dst) | ✅ | `AuditLog` — login/logout, gagal login, MFA gagal (`AuthService.verifyMfaLogin`) |
| 7.4 | Log TIDAK menyimpan credential/secret mentah | ✅ | Pino redaction untuk field sensitif (lihat `shared/config/logger.ts`) — `rawKey`/`mfaSecret` tidak pernah dilog |

## V8 — Data Protection

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 8.1 | Data sensitif tidak di-cache tanpa proteksi | ✅ | Tenant/feature-flag cache TIDAK menyimpan credential apa pun |
| 8.3 | Sensitive data dihapus/di-null-kan saat tidak diperlukan | ✅ | `MfaRepository.disableMfa` mengosongkan `mfaSecret` DAN menghapus recovery code dalam satu transaksi |

## V9 — Communications

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 9.1 | TLS di production | ✅ | Nginx + Let's Encrypt (`docs/security-guide.md`) |

## V10 — Malicious Code

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 10.3 | Dependency scanning | ✅ | `npm audit`, Trivy, GitHub Dependency Review (Phase 13, lihat `security-guide.md`) |

## V13 — API and Web Service

| # | Kontrol | Status | Catatan |
|---|---|---|---|
| 13.1 | Semua endpoint API tervalidasi input-nya | ✅ | Zod schema di setiap `*.dto.ts` |
| 13.2 | Rate limiting | ✅ | `authRateLimiter` + `generalRateLimiter`; **belum** ada limit granular khusus per percobaan kode MFA (lihat `security-guide.md` §"Belum ditegakkan") |
| 13.4 | API key TIDAK menggantikan otentikasi user sepenuhnya tanpa scope | ✅ | `ApiKeyService.resolveScopes` — scope ⊆ permission pemilik |

---

## Ringkasan gap yang diketahui (prioritas untuk fase berikutnya)

1. Row-Level Security PostgreSQL untuk isolasi tenant (V1.9).
2. Rate limit granular khusus percobaan kode MFA/recovery (V13.2).
3. Job re-encryption otomatis setelah rotasi `ENCRYPTION_KEY` (V6.3).
4. Auto-revoke API key saat pemiliknya di-soft-delete (V2.10).

Detail teknis masing-masing gap ada di `docs/tenant-migration-strategy.md`
dan `docs/security-guide.md` §"Phase 12".
