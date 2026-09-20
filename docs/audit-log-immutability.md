# Audit Log Immutability (Kelompok 2, item 2.2)

## Desain: dua lapis independen

**Lapis 1 — WORM trigger di database.** Migration
`20260915010000_audit_log_immutability` menambahkan trigger Postgres
yang **memblokir total** `UPDATE`/`DELETE` pada tabel `audit_logs` —
siapa pun/apa pun yang terhubung lewat role aplikasi biasa (termasuk
kalau aplikasinya sendiri suatu saat di-compromise) tidak bisa
mengubah atau menghapus baris audit log yang sudah ada. Cuma `INSERT`
yang diizinkan.

**Lapis 2 — hash chain kriptografis.** Setiap baris `audit_logs`
(dibuat lewat `AuditRepository.create` setelah migration ini) punya
kolom `hash` (SHA-256 atas isi baris itu sendiri + `previousHash`)
dan `previousHash` (hash baris SEBELUMNYA dalam urutan pembuatan,
`null` untuk baris pertama/genesis). Mengubah, menyisipkan, atau
menghapus satu baris pun akan membuat baris tersebut ATAU seluruh
rantai setelahnya gagal diverifikasi lewat
`AuditRepository.verifyChainIntegrity()`.

Lapis 2 ada supaya integritas tetap bisa DIBUKTIKAN independen kalau
lapis 1 entah bagaimana terlewati (mis. akses langsung sebagai
superuser Postgres, migrasi data manual, atau restore dari backup
yang punya gap) — bukan cuma "dipercaya" karena triggernya ada.

## Kenapa TIDAK backfill hash untuk baris lama

Kolom `hash`/`previousHash` **nullable** — baris yang sudah ada
SEBELUM migration ini TIDAK dihitung ulang hash-nya secara retroaktif.
Ini keputusan sadar, bukan kelalaian: backfill yang benar butuh
serialisasi PERSIS IDENTIK antara SQL (migration) dan kode aplikasi
(TypeScript) — mis. format `created_at` Postgres (`2026-09-14
19:27:24.123`) berbeda dari `Date.toISOString()` JavaScript
(`2026-09-14T19:27:24.123Z`). Kalau backfill dipaksakan dengan format
yang meleset, hasilnya adalah hash yang trerlihat "ada" tapi salah —
lebih berbahaya daripada jujur mengatakan "baris lama tidak
tercakup". Chain dimulai bersih dari baris pertama yang dibuat
setelah migration ini.

## Konkurensi: `SELECT ... FOR UPDATE`

`AuditRepository.create` mengunci baris singleton `audit_chain_state`
lewat `SELECT ... FOR UPDATE` di dalam transaksi yang sama dengan
`INSERT`-nya — ini MENYERIALKAN penulisan chain antar request/worker
yang berjalan bersamaan. Tanpa ini, dua audit log yang dibuat
BERSAMAAN bisa sama-sama membaca `lastHash` yang sama dan
menghasilkan chain yang **bercabang** (dua baris ber-`previousHash`
sama) — merusak jaminan tamper-evidence-nya diam-diam.

## Verifikasi nyata yang sudah dijalankan

Diverifikasi lewat skrip standalone (driver `pg` mentah terhadap
Postgres 16 sungguhan, mereplikasi persis logika
`AuditRepository.create`/`verifyChainIntegrity`) — 10/10 pengecekan
lolos, stabil 3x run berturut-turut:

1. **Chain dasar** (5 baris berurutan) — valid.
2. **20 audit log dibuat BERSAMAAN (real concurrency, bukan simulasi)**
   — semua 20 baris tersimpan, setiap `previousHash` UNIK (chain
   TIDAK bercabang), dan seluruh chain hasilnya tetap terverifikasi
   valid end-to-end. Ini yang paling penting — membuktikan desain
   `FOR UPDATE` benar-benar mencegah race condition, bukan cuma
   teori.
3. **Tamper terdeteksi** — satu baris diubah PAKSA langsung di
   database (trigger WORM sengaja di-disable sementara sebagai
   superuser, mensimulasikan "lapis 1 terlewati") — `verifyChainIntegrity`
   berhasil mendeteksi TEPAT baris yang di-tamper, dengan alasan yang
   benar ("hash tidak cocok").
4. **Trigger WORM dalam kondisi normal** — `UPDATE`/`DELETE` langsung
   ditolak dengan error jelas, baris tetap utuh.

**Bug nyata yang ketahuan & diperbaiki lewat pengujian konkurensi
ini**: desain awal `verifyChainIntegrity` mengurutkan baris
berdasarkan `(createdAt, id)` sebelum menelusuri chain — SALAH, karena
`createdAt` bisa collide di milidetik yang sama saat banyak insert
terjadi nyaris bersamaan, dan `id` (UUID acak) tidak berkorelasi
dengan urutan chain sebenarnya (yang ditentukan urutan lock `FOR
UPDATE`, bukan timestamp). Diperbaiki dengan menelusuri chain lewat
**tautan hash itu sendiri** (`previousHash` → `hash`, mulai dari
baris ber-`previousHash = null`), yang tidak bergantung pada urutan
baris dari query sama sekali. Test regresi untuk kasus spesifik ini
ada di `audit.repository.spec.ts`.

## Kolom `details` (temuan T2)

Kolom `audit_logs.details` (TEXT, nullable) menyimpan konteks perubahan yang tidak muat di
`action`/`entity`/`entityId`, mis. plan tenant sebelum → sesudah:
`{"field":"plan","from":"PRO","to":"ENTERPRISE"}`.

- **Disimpan sebagai TEKS JSON, bukan `Json`/JSONB.** JSONB menormalkan urutan key dan spasi, jadi
  yang dibaca ulang saat verifikasi bisa berbeda dari yang di-hash saat baris dibuat, dan chain gagal
  memverifikasi barisnya sendiri. Teks dibaca kembali byte-per-byte identik.
- **Ikut di-hash HANYA kalau terisi.** Kunci `details` ditambahkan di akhir objek kanonis hanya kalau
  non-NULL. Baris lama (semua NULL setelah migration) dan aksi tanpa konteks menghasilkan string kanonis
  yang identik byte-per-byte dengan sebelumnya, jadi hash mereka dan chain lama tidak berubah. Menambah
  `"details":null` ke semua baris akan mematahkan seluruh chain lama.
- **Tamper-evident**: mengubah, menghapus (NULL-kan), atau menambahkan `details` pada baris yang sudah
  ada terdeteksi `verifyChainIntegrity()` (dites, termasuk lewat endpoint `PATCH /tenants/:id/plan`
  end-to-end).
- **Jangan isi dengan data pribadi (PII).** Baris audit tidak bisa dihapus atau dikoreksi (WORM),
  termasuk oleh penghapusan data ala GDPR (`docs/data-retention-policy.md`).
- Migration `20260920000000_audit_log_details` hanya `ADD COLUMN`: trigger WORM memblokir UPDATE/DELETE
  baris, bukan DDL.
- Belum dipakai untuk aksi selain perubahan plan tenant; `AuditService.logUpdate` menerima `details`
  opsional, aksi lain tidak berubah.

## Deteksi terjadwal + on-demand

- **Job harian** (`verify-audit-chain-integrity`, jam 03:00 UTC) —
  menjalankan `verifyChainIntegrity()` dan **melempar error** (bukan
  cuma log info) kalau chain terbukti rusak, supaya masuk jalur
  alerting job yang sama seperti kegagalan lain.
- **Endpoint admin on-demand** — `GET /auth/admin/audit/integrity`
  (permission `audit.read`, sama dengan riwayat login) untuk
  pengecekan manual kapan saja, di luar jadwal harian.

## Yang belum tercakup (scope sadar)

- **GDPR right-to-erasure (item 2.3, belum dikerjakan)** akan
  berkonflik dengan trigger WORM ini kalau nanti perlu menghapus data
  pribadi dari audit log seorang user — trigger saat ini memblokir
  SEMUA `DELETE` tanpa pengecualian. Perlu keputusan eksplisit saat
  2.3 dikerjakan: exception mechanism yang di-scope ketat (mis. lewat
  session GUC yang cuma di-set oleh prosedur erasure resmi), atau
  ANONIMISASI (null-kan `userId`/`ipAddress` lewat baris BARU yang
  menyatakan "data user X telah dihapus", bukan menghapus baris lama)
  yang justru lebih selaras dengan filosofi append-only di sini.
  BUKAN diselesaikan sekarang — cuma didokumentasikan supaya tidak
  jadi kejutan nanti.
- Tidak ada UI/dashboard untuk melihat status integritas chain — baru
  ada API-nya (`GET /auth/admin/audit/integrity`).
