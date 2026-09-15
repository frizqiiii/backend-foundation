# Data Retention Policy & GDPR Erasure (Kelompok 2, item 2.3)

## Ringkasan apa yang dipertahankan vs dihapus

| Data | Retensi | Alasan |
|---|---|---|
| `AuditLog` | **Selamanya** (WORM, tidak bisa dihapus/diubah) | Kewajiban hukum & keamanan — GDPR Art. 17(3)(b)/(e) mengizinkan pengecualian right-to-erasure untuk kepatuhan hukum & pembelaan klaim hukum. Lihat `docs/audit-log-immutability.md`. |
| `RefreshToken`/`BlacklistedToken` kedaluwarsa | Dihapus otomatis (job harian yang sudah ada) | Bukan data pribadi jangka panjang — token akses sementara. |
| Akun soft-deleted (`deletedAt` terisi, admin) | **30 hari masa tenggang** (`DATA_RETENTION_GRACE_PERIOD_DAYS`), lalu otomatis di-erasure | Beri waktu admin membatalkan kalau keliru, tapi tidak menyimpan PII selamanya "kalau-kalau". |
| Data pribadi user yang minta erasure sendiri | **Langsung** (`POST /users/me/erasure`) | Hak GDPR Art. 17 (right to erasure), tidak ada alasan menunda. |
| `Product`/`Event`/`WebhookEndpoint` milik user | **Tidak ikut terhapus/di-scrub** saat erasure | Dianggap konten bisnis/marketplace, bukan data pribadi requester itu sendiri — menghapusnya bisa merusak data pihak lain (mis. orang lain yang sudah berinteraksi dengan event/product itu). `userId`-nya tetap menunjuk ke akun yang sudah di-scrub (nama jadi "Deleted User"). |

## Apa yang di-scrub/dihapus saat erasure (`PrivacyService`)

Satu transaksi database ATOMIC (`PrivacyRepository.eraseUserData`) —
lihat komentar desain lengkap di file itu:

- **`User`**: `email` → `erased-<id>@erased.invalid` (placeholder
  deterministik per-id, tidak pernah tabrakan unique constraint),
  `name` → "Deleted User", `password`/`mfaSecret`/`mfaEnabledAt` →
  null, `mfaEnabled` → false, `deletedAt`+`erasedAt` → sekarang. Baris
  **TIDAK dihapus** (dipertahankan untuk integritas referensial
  Product/Event di atas).
- **Dihapus total**: `OAuthAccount`, `SsoIdentity`, `RefreshToken`,
  `MfaRecoveryCode`, `EmailVerificationToken`, `PasswordResetToken`,
  `ApiKey`, `FileUpload` (baris DB + objek storage aktualnya, dihapus
  di luar transaksi SEBELUM baris DB-nya, pola sama dengan
  `UploadService.deleteFile`).

## Dua jalur pemicu erasure

1. **Self-service**: `POST /users/me/erasure` — wajib konfirmasi
   password (kecuali akun SSO/OAuth-only tanpa password lokal).
2. **Admin/otomatis**: `POST /users/admin/:id/erasure` (permission
   `user.manage`) ATAU job terjadwal harian
   `enforce-data-retention` (03:30 UTC) — otomatis memproses SEMUA
   akun yang sudah soft-delete lebih dari 30 hari.

## Verifikasi nyata yang sudah dijalankan

Skrip standalone (driver `pg` mentah, Postgres 16 sungguhan,
mereplikasi persis transaksi `PrivacyRepository.eraseUserData`) —
15/15 pengecekan lolos:

1. **Erasure lengkap** — semua field PII ter-scrub sesuai desain,
   SEMUA tabel terkait (oauth/refresh-token/mfa-recovery/dst) kosong
   untuk user tersebut.
2. **Placeholder email unik antar-user** — dua user berbeda di-erasure
   berurutan, tidak ada tabrakan unique constraint.
3. **Atomicity (paling kritis)** — kegagalan disimulasikan DI TENGAH
   transaksi (setelah `oauth_accounts` terhapus, sebelum langkah
   lain) → **ROLLBACK TOTAL** terbukti: `email` masih ASLI,
   `password` masih ada, `oauth_accounts` yang SEMPAT terhapus pun
   ikut kembali (rollback membatalkan seluruh transaksi, bukan cuma
   langkah yang gagal) — membuktikan tidak ada kondisi "separuh
   ter-erasure" yang justru lebih buruk (identifiable TAPI sesi/kredensial
   sudah rusak).

## Yang belum tercakup (scope sadar)

- Tidak ada endpoint "undo/restore" untuk akun yang di-soft-delete
  sebelum masa tenggang 30 hari habis — kalau dibutuhkan, itu perlu
  endpoint terpisah (`POST /users/admin/:id/restore`), belum ada di
  iterasi ini.
- File di storage provider (S3/local) yang GAGAL dihapus (mis. S3
  sedang gangguan) hanya dicatat sebagai error log — tidak ada retry
  otomatis/dead-letter queue untuk file storage yang gagal dihapus.
  PII di DATABASE tetap tuntas ter-scrub terlepas dari ini (tujuan
  utama GDPR erasure), tapi objek file yang gagal terhapus itu
  sendiri butuh penanganan manual kalau terjadi.
- Tidak ada notifikasi email ke user saat erasure berhasil/gagal.
