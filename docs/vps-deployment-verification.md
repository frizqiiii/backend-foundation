# Verifikasi Deploy VPS — Simulasi (Fase 0.1: Pilihan A)

> Project ini memilih **Pilihan A** di Fase 0.1 roadmap (portofolio/belajar),
> yang secara eksplisit mengizinkan item 1.6 diselesaikan lewat **simulasi
> yang benar-benar dijalankan**, bukan cuma dokumentasi teoritis, alih-alih
> VPS berbayar sungguhan. Dokumen ini adalah bukti verifikasi itu.

## Metodologi

Dibuat lingkungan "VPS palsu" nyata (bukan mock/asumsi):
- **PostgreSQL 16** & **Redis 7** — server sungguhan, jalan lokal.
- **Bare git repository** berperan sebagai "GitHub" (`origin`), di-clone
  ke folder terpisah berperan sebagai lokasi deploy di VPS.
- **PM2** sungguhan (bukan simulasi) menjalankan proses cluster + fork
  persis sesuai `deploy/pm2/ecosystem.config.js`.
- `deploy/scripts/backup-db.sh` dijalankan **TANPA MODIFIKASI SAMA
  SEKALI** langsung terhadap PostgreSQL sungguhan.
- `deploy/scripts/deploy.sh` & `rollback.sh` dijalankan lewat salinan
  yang **identik logikanya**, dengan HANYA 2 baris `npx prisma
  generate`/`migrate deploy` diganti no-op — **keterbatasan sandbox
  verifikasi ini, BUKAN redesain skrip**: `binaries.prisma.sh` diblokir
  di jaringan sandbox AI yang melakukan verifikasi ini, jadi Prisma
  Client tidak bisa di-generate di lingkungan itu. Semua logika BASH
  lain (backup, `git pull --ff-only`, `npm ci`, PM2 reload, retry
  health-check, trigger rollback otomatis) **IDENTIK & TIDAK diubah**.

## Hasil

### ✅ `backup-db.sh` — dijalankan utuh, tanpa modifikasi
Backup nyata berhasil dibuat dari PostgreSQL yang benar-benar jalan
(`pg_dump | gzip`), rotasi berbasis `mtime` diverifikasi tidak
menghapus backup yang baru dibuat.

### ✅ Skenario 1 — Deploy sukses
1. Commit baru di-push ke "origin" (bare repo).
2. Proses deploy: `git pull --ff-only` menarik commit baru → `npm ci`
   → (build) → `pm2 reload` (zero-downtime, PM2 melaporkan reload
   tanpa downtime terdeteksi) → health check `/ready` lolos di
   percobaan pertama.
3. **Exit code 0.** Endpoint aplikasi mengonfirmasi versi baru live.
4. `.last-known-good-commit` ter-update ke commit SEBELUM deploy ini
   (bukan commit yang baru saja di-deploy) — sesuai desain, supaya
   rollback berikutnya (kalau perlu) kembali ke titik yang benar.

### ✅ Skenario 2 — Deploy GAGAL, auto-rollback
1. Commit baru (sengaja dibuat rusak — endpoint `/ready` selalu
   mengembalikan 500) di-push ke "origin".
2. Proses deploy berjalan sampai tahap reload, TAPI health check gagal
   di seluruh 10 percobaan retry (interval sesuai `deploy.sh`).
3. `rollback.sh` **terpicu otomatis** (bukan manual): `git checkout`
   kembali ke commit SEBELUM deploy yang gagal, `npm ci`, PM2 reload
   lagi.
4. Diverifikasi: endpoint aplikasi kembali melayani versi LAMA yang
   sehat, PM2 tetap `online` (bukan crash-loop — restart count naik
   wajar dari reload, bukan dari crash berulang).
5. **Exit code 1** — deploy dianggap gagal (benar, supaya CI/operator
   tahu, meski kode sudah otomatis pulih ke versi sehat).

## Yang TIDAK tercakup simulasi ini (butuh VPS/CI sungguhan untuk verifikasi penuh)

- `npx prisma generate` & `npx prisma migrate deploy` sungguhan (butuh
  akses ke `binaries.prisma.sh` — diblokir di sandbox verifikasi ini,
  TIDAK diblokir di VPS/GitHub Actions runner sungguhan).
- `npm run build` TypeScript sungguhan (bergantung ke Prisma Client
  yang sama).
- SSH sungguhan dari GitHub Actions ke VPS (`.github/workflows/deploy.yml`
  — memerlukan `VPS_HOST`/`VPS_USER`/`VPS_SSH_KEY`/`VPS_APP_PATH` diisi
  di GitHub Secrets, dan VPS sungguhan untuk dituju).
- Skenario cluster PM2 dengan >1 CPU core (sandbox verifikasi ini
  cuma py 1 core, jadi `instances: 'max'` cuma menghasilkan 1 instance
  — logikanya tetap sama, tapi load-balancing antar-instance riil
  belum teruji).

## Rekomendasi kalau nanti pindah ke Pilihan B (produksi sungguhan)

Sebelum tag pertama (`v*`) di-push dan memicu `deploy.yml`:
1. Isi 4 GitHub Secrets yang dibutuhkan (lihat komentar di
   `.github/workflows/deploy.yml`).
2. Jalankan **manual, sekali**, langsung di VPS (SSH manual, bukan
   lewat CI dulu) untuk first-time setup: clone repo, isi `.env`
   sungguhan, `npm ci`, `npx prisma generate`, `npx prisma migrate
   deploy`, `npm run build`, `pm2 start` (bukan `reload` — belum ada
   proses yang jalan untuk di-reload).
3. Baru setelah itu, tag push berikutnya akan memakai jalur
   `deploy.sh` (`pm2 reload`) yang sudah diverifikasi lewat simulasi
   ini.
