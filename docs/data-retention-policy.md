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

## Temuan audit T15: dua cacat yang membuat erasure tidak benar-benar bekerja (sudah diperbaiki)

Audit kode item 2.3 (dibuat sesi AI paralel tanpa akses jaringan/database) menemukan dua cacat yang lolos dari
seluruh unit test, karena unit test memakai repository/Prisma tiruan.

1. **API key tidak ikut terhapus saat erasure (RLS diam-diam menghapus 0 baris).** `api_keys` memakai `FORCE ROW
   LEVEL SECURITY`. `PrivacyRepository.eraseUserData` membuka `$transaction` biasa tanpa `app.tenant_id` maupun
   `app.bypass_rls`, sehingga `apiKey.deleteMany({ where: { userId } })` tidak melihat satu baris pun dan
   "berhasil" menghapus 0 tanpa error. Terbukti di PostgreSQL 16 sungguhan (non-superuser, FORCE RLS): transaksi
   erasure mengembalikan `UPDATE 1`, `DELETE 0` (api_keys), `DELETE 1` (file_uploads, tabel tanpa RLS), `COMMIT`
   — lalu API key `k1` masih ada; `DELETE` yang sama dengan `app.bypass_rls = 'on'` menghapus 1 baris. Konteks tenant
   request tidak menolong (hidup di transaksi milik middleware, sedangkan repository membuka koneksi sendiri) dan job
   harian tidak punya konteks request sama sekali.
   **Dampak:** klaim "`ApiKey` dihapus total" di atas tidak terpenuhi (baris berisi `name` buatan user dan `userId`
   tetap ada). Key itu sendiri tidak bisa dipakai autentikasi, karena `findById` menyembunyikan pemiliknya yang sudah
   `deletedAt` — jadi ini kegagalan kepatuhan/retensi, bukan celah autentikasi.
   **Perbaikan:** `eraseUserData` memakai `withRlsBypass` (satu transaksi dengan `app.bypass_rls = 'on'`), ditambah
   pengaman "gagal keras": setelah semua `deleteMany`, sisa baris di delapan tabel dihitung; kalau ada yang tersisa,
   error dilempar dan seluruh transaksi (termasuk scrub `User`) di-rollback, supaya kegagalan sejenis tidak lagi bersembunyi.

2. **Job retensi 30 hari tidak pernah bisa meng-erasure akun mana pun.** `enforce-data-retention` mengambil akun
   soft-deleted (`deletedAt < cutoff`), lalu `PrivacyService.eraseForUser` mencari pemiliknya lewat `findById`, yang
   memfilter `deletedAt: null` — jadi setiap kandidat "tidak ditemukan" (`NotFoundError`), job melaporkan gagal tiap
   malam, dan PII akun terhapus tidak pernah dibersihkan. Endpoint admin `POST /users/admin/:id/erasure` untuk akun
   soft-deleted juga 404. Terbukti di PostgreSQL sungguhan: query `findById` mengembalikan 0 baris untuk akun soft-deleted,
   query tanpa filter mengembalikan 1.
   **Perbaikan:** `UserRepository.findByIdIncludingDeleted` (tanpa filter `deletedAt`, khusus erasure; `findById` untuk
   jalur auth sengaja tidak diubah) dipakai oleh `eraseForUser`.

**Koreksi klaim "Verifikasi nyata" di atas:** skrip 15/15 itu mereplikasi transaksi repository dengan driver `pg` mentah
dan tidak berjalan sebagai role non-superuser di bawah FORCE RLS, serta tidak melewati rantai service → finder, sehingga
keduanya tidak tercakup. Bukti sesudah perbaikan: `src/modules/privacy/privacy-erasure-rls.e2e.spec.ts` (Prisma dan
Postgres sungguhan, `npm run test:rls`) memuat kontrol yang membuktikan RLS memang menghapus 0 baris tanpa bypass.

### Pemakaian `withRlsBypass` yang diizinkan

`tenant-context.ts` menyebut bahwa setiap pemakaian `withRlsBypass` harus terdaftar; daftar itu belum ada di dokumen mana pun.
Pemakaian di kode produksi saat ini hanya satu:

| Lokasi | Alasan |
|---|---|
| `PrivacyRepository.eraseUserData` | Erasure bersifat lintas-tenant (satu user bisa punya kunci di beberapa tenant) dan dipicu admin/job tanpa konteks tenant. |

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
