# Hasil DR Drill — Simulasi Nyata (Fase 0.1: Pilihan A)

> Project ini memilih **Pilihan A** di Fase 0.1 roadmap (portofolio/belajar),
> yang secara eksplisit mengizinkan item 2.6 diselesaikan lewat **simulasi
> yang benar-benar dijalankan**, bukan cuma dokumentasi teoritis. Dokumen
> ini adalah bukti drill itu — mengikuti prosedur yang SUDAH ada di
> `docs/disaster-recovery-guide.md` § "Uji DR Secara Berkala", dijalankan
> untuk pertama kalinya secara nyata.

> **KOREKSI (temuan T19):** drill ini dijalankan dengan role yang mem-bypass RLS (superuser), jadi tidak
> mengungkap bahwa `backup-db.sh` **gagal** dengan role aplikasi di bawah `FORCE ROW LEVEL SECURITY`, bahwa jalan pintas
> `--enable-row-security` menghasilkan backup kosong yang lolos verifikasi, dan bahwa `verify-backup.sh` bisa menimpa
> production lewat `VERIFY_DATABASE_URL` yang ejaannya berbeda. Semuanya sudah diperbaiki; lihat
> `docs/backup-restore-guide.md` (bagian "WAJIB: role backup harus mem-bypass Row-Level Security"). Hasil di bawah tetap
> berlaku untuk role superuser.

## Metodologi

Dibuat instance PostgreSQL 16 sungguhan (bukan mock), skema di-apply
dari SELURUH 22 file `prisma/migrations/*/migration.sql` **tanpa
modifikasi sama sekali** (termasuk migration RLS terbaru,
`20260913120000_enable_rls_multi_tenancy`), lalu diseed data
representatif: **1.000 users, 500 events, 500 products** (relasi FK
antar tabel diisi, bukan tabel kosong).

Skrip yang diuji — **`scripts/backup-db.sh`, `scripts/restore-db.sh`,
`scripts/verify-backup.sh`, dijalankan UTUH tanpa modifikasi satu
baris pun**, persis seperti yang akan dipakai di production.

**Keterbatasan sandbox verifikasi ini (BUKAN redesain skrip)**:
`npx prisma migrate deploy`/`prisma generate` tidak bisa dijalankan
di sandbox AI (`binaries.prisma.sh` diblokir) — skema di-apply lewat
`psql -f migration.sql` langsung (isi file SQL-nya IDENTIK dengan
yang dijalankan `prisma migrate deploy`, cuma tanpa mencatat riwayat
ke tabel `_prisma_migrations`). Konsekuensinya, drill ini TIDAK
mencakup langkah "app boot + `GET /ready`" dari skenario di
`disaster-recovery-guide.md` (butuh Prisma Client sungguhan) — lihat
"Yang TIDAK tercakup" di bawah.

## Hasil

### ✅ Skenario: Database Primary Hilang/Corrupt Total

Mengikuti persis langkah di `disaster-recovery-guide.md` §
"Database Primary Hilang/Corrupt Total":

1. **Backup** (`scripts/backup-db.sh`, tanpa modifikasi) — berhasil,
   `backup_20260914_192724.dump` (76 KB, format custom `pg_dump -F c`),
   sidecar `.meta` tercatat otomatis (`rowcount_users=1000`,
   `rowcount_events=500`, `rowcount_products=500`). **0.27 detik.**
2. **Disaster disimulasikan** — database primary **dihapus total**
   (`dropdb`), bukan sekadar tabel dikosongkan.
3. **Instance baru di-provision** — database kosong dibuat ulang
   (`createdb`). **0.11 detik** (di sandbox lokal — provisioning
   VPS/cluster BARU sungguhan di dunia nyata jelas jauh lebih lama,
   lihat catatan skala di bawah).
4. **Restore** (`scripts/restore-db.sh <file> --yes`, tanpa
   modifikasi) — berhasil, seluruh 19 tabel + tipe enum + FK + index
   + **RLS policies (`FORCE ROW LEVEL SECURITY` + 5 policy
   `tenant_isolation`)** ter-restore dengan benar. **0.20 detik.**
5. **Verifikasi integritas data** — row count SETELAH restore
   dibandingkan dengan sidecar `.meta` SAAT backup dibuat:
   `users` 1000=1000, `events` 500=500, `products` 500=500 — **cocok
   persis, nol data hilang** (RPO tervalidasi = 0 untuk skenario ini,
   karena tidak ada transaksi baru antara backup dan disaster).

### ✅ `scripts/verify-backup.sh` — path sukses

Dijalankan persis sesuai dokumentasi (`VERIFY_DATABASE_URL` menunjuk
ke database disposable terpisah, bukan primary): restore ke database
verifikasi berhasil, ketiga tabel kunci **[OK]**, **exit code 0**.

### ✅ `scripts/verify-backup.sh` — path GAGAL (uji negatif)

Supaya yakin skrip verifikasi ini benar-benar **bisa mendeteksi**
backup rusak (bukan cuma selalu melaporkan "OK"), diuji dengan file
backup yang **sengaja dirusak** (dipotong jadi separuh ukuran asli,
mensimulasikan dump yang terputus/gagal di tengah jalan):
- `pg_restore` gagal dengan `could not read from input file: end of file`.
- Skrip melaporkan `FATAL: ... backup TERBUKTI TIDAK VALID` dan
  **exit code 1** — sesuai desain untuk trigger alert di cron/CI.

## Temuan (minor, didokumentasikan apa adanya)

- `docs/backup-restore-guide.md` menyebut `VERIFY_DATABASE_URL` harus
  menunjuk ke "database kosong/disposable", tapi tidak eksplisit
  bilang database itu **harus sudah dibuat lebih dulu** (`createdb`)
  sebelum `verify-backup.sh` dijalankan — `pg_restore` tidak membuat
  database baru sendiri. Bukan bug (pesan error skrip sudah jelas:
  `database "..." does not exist`, tidak gagal diam-diam), tapi
  layak ditambahkan sebagai catatan prasyarat di dokumentasi.

## Yang TIDAK tercakup drill ini (butuh environment sungguhan untuk menutup sepenuhnya)

- **`npx prisma migrate deploy` + app/worker boot + `GET /ready`** —
  langkah 4-6 di skenario `disaster-recovery-guide.md` butuh Prisma
  Client sungguhan, tidak bisa dijalankan di sandbox AI ini (lihat
  "Keterbatasan" di atas). Ini bagian yang paling relevan untuk
  memvalidasi ANGKA RTO ~2 jam di dokumen tersebut secara utuh (waktu
  provisioning + migrate + restart proses), bukan cuma mekanika
  backup/restore-nya.
- **Skala data production sungguhan** — 76 KB/2.000 baris total di
  drill ini trivial dibanding data production nyata; waktu backup
  (0.27 detik) TIDAK bisa dijadikan acuan waktu backup production
  (yang bisa berjam-jam untuk database besar). Yang divalidasi drill
  ini adalah **KEBENARAN prosedurnya** (skrip bekerja, data utuh,
  RLS ikut ter-restore, verifikasi mendeteksi korupsi) — bukan angka
  RTO/RPO absolut di skala production.
- **Provisioning infrastruktur BARU sungguhan** (VPS/k8s cluster dari
  nol) — `createdb` 0.11 detik di sini cuma mensimulasikan "database
  kosong siap dipakai", bukan waktu sewa+setup server baru yang
  sesungguhnya (itulah kenapa target RTO di `disaster-recovery-guide.md`
  tetap ~2 jam, didominasi waktu provisioning manual, bukan waktu restore).

## Kesimpulan

**Mekanika DR — backup, disaster, provision, restore, verifikasi
integritas, deteksi korupsi — TERBUKTI BEKERJA end-to-end lewat
simulasi nyata**, bukan lagi cuma asumsi teoritis seperti yang
diakui jujur di "Catatan kejujuran" `disaster-recovery-guide.md`
sebelum drill ini. RPO = 0 tervalidasi untuk skenario "tidak ada
transaksi baru sejak backup terakhir". Bagian yang masih perlu
ditutup di environment sungguhan (bukan sandbox): replay migration +
app boot + `GET /ready` timing, untuk memvalidasi angka RTO ~2 jam
secara utuh di skala production.
