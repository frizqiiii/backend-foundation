# Developer Guide

## Setup Lokal

```bash
git clone <url-repo> && cd backend-foundation
npm ci
cp .env.example .env    # isi DATABASE_URL, JWT_SECRET, dst

# Database & Redis lewat Docker (paling cepat untuk dev)
docker compose up -d postgres_db redis

npx prisma generate
npx prisma migrate dev
npm run db:seed          # opsional — data contoh

npm run dev               # API server, http://localhost:3000
npm run worker:dev        # di terminal terpisah — proses worker BullMQ
```

## Konvensi Kode

- **Bahasa komentar**: Bahasa Indonesia, menjelaskan **alasan** (kenapa),
  bukan mengulang apa yang sudah jelas dari kode itu sendiri.
- **Satu modul = satu domain bisnis** — lihat `docs/architecture.md`
  untuk struktur wajib tiap modul (`routes → controller → service →
  repository`).
- **Aturan lapisan yang TIDAK BOLEH dilanggar**:
  - Controller tidak pernah memanggil Repository langsung.
  - Service tidak pernah mengimpor `@prisma/client` langsung.
- **Validasi input**: selalu lewat skema Zod di `<modul>.dto.ts`,
  tidak pernah manual `if` checking di Controller/Service.
- **Error handling**: lempar subclass `HttpError` (`shared/utils/http-error.ts`)
  dari Service — jangan `res.status().json()` manual di luar Controller.

## Menambah Modul Baru

1. Buat folder `src/modules/<nama>/` dengan 5 file wajib (lihat
   `docs/architecture.md` §"Lapisan di Dalam Satu Modul") — copy
   struktur dari modul existing yang paling mirip (mis. `products/`
   untuk CRUD sederhana).
2. Kalau butuh tabel baru: tambah `model` di `prisma/schema.prisma`,
   buat migration (`npx prisma migrate dev --name <nama_migration>`),
   ikuti pola komentar yang sudah ada di schema (jelaskan alasan index/
   constraint, bukan cuma deklarasi kosong).
3. Kalau endpoint perlu proteksi permission: tambah permission baru di
   `shared/security/permissions.ts` (`Permission` type + masukkan ke
   role yang relevan di `ROLE_PERMISSIONS`), pakai `requirePermission()`
   di routes.
4. Daftarkan router modul baru di `src/app.ts`.
5. Tulis unit test (`<modul>.service.spec.ts`, mock Repository) —
   `jest.config.ts` mewajibkan coverage minimal 90% statements/functions/lines
   (85% branches) sejak Phase 21 — sebelumnya 80%/70%.
6. Kalau modul memanggil service pihak ketiga (email/SMS/payment/dst):
   bungkus panggilannya dengan `resilientCall` (`shared/reliability/`,
   Phase 18) — lihat contoh di `shared/integrations/email/resend-email.provider.ts`.
   JANGAN `fetch()` polos tanpa timeout.

## Menjalankan Test

```bash
npm test                  # semua test (unit + integration + e2e) - TIDAK termasuk contract test
npm run test:watch        # mode watch selama development
npm run test:coverage     # dengan laporan coverage (WAJIB prisma generate dulu)
npm run test:e2e          # hanya file *.e2e.spec.ts
npm run test:contract     # Phase 21 - Pact provider verification, BUTUH database sungguhan, lihat auth.provider.contract.spec.ts
npm run test:mutation     # Phase 21 - Stryker, scope terbatas (lihat MUTATION_TESTING.md), lambat
```

Semua test (termasuk e2e) memakai `jest-mock-extended` untuk mock
Prisma & S3 — **tidak butuh** database/Redis sungguhan untuk
menjalankan test suite.

## Lint & Format

```bash
npm run lint               # ESLint dengan auto-fix
npm run lint:ci             # ESLint TANPA auto-fix, gagal di warning apa pun (dipakai CI)
npm run format               # Prettier write
npm run format:check         # Prettier check-only (dipakai CI)
```

## Debugging Umum

| Masalah | Penyebab Umum |
|---|---|
| `Cannot find module '@prisma/client'` atau error tipe Prisma | Lupa `npx prisma generate` setelah pull/ubah schema |
| Test gagal semua tiba-tiba | Cek `jest.setup.ts` — env dummy untuk test mungkin belum mencakup env var baru yang ditambahkan ke `env.ts` |
| Worker tidak memproses job | Cek `REDIS_URL` terisi — worker BullMQ SENGAJA `null`/nonaktif kalau Redis tidak dikonfigurasi (lihat `queue/connection.ts`) |
| Endpoint baru selalu 403 | Permission belum ditambahkan ke `ROLE_PERMISSIONS` untuk role yang diuji |

## Struktur Dokumentasi Lain

- `docs/architecture.md` — kenapa struktur ini dipilih
- `docs/erd.md` — skema database lengkap
- `docs/security-guide.md` — seluruh lapisan keamanan
- `docs/runbook.md` — prosedur operasional (deploy, rollback, scale, dst)
- `docs/incident-response-guide.md` — klasifikasi severity & playbook insiden
- `deploy/README.md` — cara deploy ke production (VPS)
- `k8s/README.md` — cara deploy ke Kubernetes + blue-green/canary
