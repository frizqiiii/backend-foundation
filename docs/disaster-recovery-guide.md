# Disaster Recovery Guide

Panduan level-tinggi untuk kehilangan **infrastruktur**, bukan
sekadar bug/insiden operasional (untuk itu, lihat
`docs/incident-response-guide.md`). Untuk LANGKAH TEKNIS backup/restore
database, dokumen ini merujuk ke `docs/backup-restore-guide.md`
(SENGAJA tidak diduplikasi di sini — satu sumber kebenaran untuk
mekanika, dokumen ini fokus ke KAPAN/KENAPA/target waktu).

## RTO & RPO

| Skenario | RTO (target waktu pulih) | RPO (target maksimal data hilang) |
|---|---|---|
| Database primary hilang/corrupt | ~2 jam (provision instance baru + restore backup terbaru + replay migration) | ~24 jam (backup terjadwal harian) ATAU sejak deploy terakhir (backup otomatis pre-migration, biasanya jauh lebih baru dari 24 jam) |
| Redis hilang total | ~15 menit (provision ulang — Redis TIDAK menyimpan data yang tidak boleh hilang, lihat klasifikasi "opsional" di `docs/infrastructure-diagram.md`) | 0 — tidak ada data yang HARUS dipertahankan (cache/queue in-flight boleh hilang, worker akan retry job yang belum sempat selesai lewat mekanisme BullMQ attempts) |
| Object Storage (S3) hilang | Tergantung SLA provider (biasanya provider S3-compatible sudah replikasi internal — risiko kehilangan total sangat rendah); kalau memang terjadi, file yang sudah diupload user (avatar, export, dst) TIDAK bisa dipulihkan tanpa backup terpisah | N/A — proyek ini TIDAK backup object storage secara terpisah saat ini (gap yang diketahui, lihat "Kapabilitas Lanjutan" di bawah) |
| VPS/Cluster hilang total (server mati, provider down) | ~4 jam (provision infrastruktur baru dari awal: VPS baru + `deploy/README.md` setup ATAU cluster k8s baru + `helm install`) + waktu restore database | Sama seperti skenario database di atas |
| Region/datacenter provider down | Tergantung apakah ada DR site standby — **proyek ini TIDAK punya multi-region/standby site saat ini** (di luar cakupan; lihat "Kapabilitas Lanjutan") | — |

**Catatan kejujuran**: angka RTO/RPO di atas adalah **target yang
diturunkan dari kapabilitas infrastruktur yang ADA SEKARANG**
(cadence backup harian, waktu provisioning manual yang wajar), BUKAN
SLA yang diukur di skala production sungguhan. **Update**: mekanika
prosedur recovery-nya (backup → disaster → provision → restore →
verifikasi integritas data → deteksi backup korup) SUDAH diuji lewat
DR drill nyata — lihat `docs/disaster-recovery-drill-results.md` untuk
hasilnya. Yang masih belum tervalidasi di skala production: waktu
`prisma migrate deploy` + app boot + `GET /ready`, dan waktu
provisioning infrastruktur baru sungguhan (bukan simulasi) — lihat
bagian "Yang TIDAK tercakup" di dokumen hasil drill tersebut.

## Skenario Detail

### Database Primary Hilang/Corrupt Total

1. **Deklarasikan SEV1** (lihat `docs/incident-response-guide.md`).
2. Provision instance PostgreSQL baru (versi sama dengan yang
   ditinggalkan — cek `docker-compose.prod.yml`/Helm values untuk versi image).
3. Restore backup TERBARU — lihat `docs/backup-restore-guide.md` §
   Restore untuk perintah persis (`.dump` vs `.sql.gz`, tergantung
   sumber backup mana yang tersedia).
4. `npx prisma migrate deploy` — replay migration yang terjadi
   SETELAH backup itu dibuat (kalau ada gap waktu).
5. Update `DATABASE_URL` di seluruh proses (API + worker) ke instance baru.
6. Verifikasi lewat `GET /ready` sebelum mengarahkan traffic production.
7. **Post-mortem WAJIB** — apa pun penyebabnya (hardware failure,
   human error, serangan), catat dan tinjau apakah RPO 24 jam
   ternyata cukup atau perlu diperketat (backup lebih sering).

### VPS/Cluster Hilang Total

**VPS**: ikuti `deploy/README.md` dari awal (provisioning server baru,
install dependency, clone repo, setup `.env`) — SEBELUM
`deploy/scripts/deploy.sh` pertama kali, restore database dulu (lihat
skenario di atas) supaya `prisma migrate deploy` di dalam `deploy.sh`
tidak mencoba migrate database kosong yang seharusnya sudah berisi data.

**Kubernetes**: provision cluster baru → `helm install` (lihat
`terraform/README.md` untuk pola Terraform-managed, atau manual
`helm install` langsung) → restore database sebelum traffic pertama
diarahkan ke sini.

### Kehilangan Akses ke Secret/Kredensial (bukan kebocoran — LUPA/hilang)

Kalau `JWT_SECRET`/`ENCRYPTION_KEY`/kredensial database hilang (bukan
bocor, tapi tidak ada yang punya salinannya lagi — mis. satu-satunya
tempat penyimpanan password manager hilang):

- `JWT_SECRET` — regenerasi baru AMAN (seluruh sesi aktif akan invalid,
  user perlu login ulang, TIDAK ada kehilangan data).
- `ENCRYPTION_KEY` — **TIDAK AMAN diregenerasi tanpa proses migrasi**
  — data yang sudah dienkripsi (mis. `mfaSecret` di `User`) akan
  PERMANEN tidak bisa didekripsi kalau key aslinya benar-benar hilang.
  Ini alasan `ENCRYPTION_KEY` (dan seluruh secret produksi) HARUS
  tersimpan di secret manager dengan redundansi (Vault/AWS Secrets
  Manager/dst), BUKAN hanya di satu tempat — lihat peringatan yang
  sama di `terraform/README.md` § State file.

## Uji DR Secara Berkala

**Target RTO/RPO di atas TIDAK BERARTI APA-APA kalau belum pernah
diuji sungguhan.** Jadwalkan DR drill (disarankan tiap kuartal):

1. Provision environment STAGING terpisah dari nol (bukan reuse yang
   sudah ada) — simulasikan "infrastruktur hilang total".
2. Restore dari backup production TERBARU — jalankan
   `scripts/verify-backup.sh` (Phase 20, otomatis membandingkan hasil
   restore dengan metadata backup, lihat `docs/backup-restore-guide.md`
   § "Verifikasi Backup Benar-Benar Bisa Dipakai") alih-alih verifikasi
   manual.
3. Ukur waktu ACTUAL dari mulai sampai `GET /ready` sukses — bandingkan
   dengan target RTO di tabel atas.
4. Catat setiap langkah yang ternyata lebih lambat/rumit dari
   dokumentasi ini — update dokumen ini, JANGAN biarkan drift antara
   dokumentasi dan realita (persis masalah yang ditemukan saat audit
   Phase 21 ini terhadap dokumen-dokumen lain).

## Kapabilitas Lanjutan (Diketahui Belum Ada — Bukan Terlewat)

- **Backup object storage terpisah** — file di S3-compatible storage
  saat ini bergantung sepenuhnya pada durability provider, tidak ada
  backup independen di sistem ini.
- **Multi-region/standby site** — tidak ada DR site yang siap
  menerima traffic kalau region utama down total.
- **Automated failover database** (mis. Patroni/RDS Multi-AZ) — restore
  saat ini manual (lihat langkah di atas), bukan otomatis.

Ketiganya keputusan investasi infrastruktur yang perlu ditinjau
terpisah berdasarkan kebutuhan bisnis sungguhan (biaya vs risiko yang
mau ditanggung), bukan sesuatu yang bisa diasumsikan begitu saja.
