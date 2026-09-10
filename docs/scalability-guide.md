# Scalability Guide (Phase 14 — Enterprise Scalability)

Ringkasan seluruh kapabilitas scaling yang tersedia, kapan memakainya,
dan keterbatasannya. Semua fitur di fase ini mengikuti pola yang sama
seperti fase sebelumnya: **opt-in dan backward compatible** — tanpa
konfigurasi tambahan apa pun, aplikasi berjalan PERSIS seperti sebelum
Phase 14.

## Redis Cluster Preparation

**Env**: `REDIS_CLUSTER_NODES` (comma-separated `host:port`, opsional).

Kalau diisi, cache client (`shared/config/redis.ts`) otomatis memakai
`Redis.Cluster` (ioredis) alih-alih koneksi tunggal. `REDIS_URL`
diabaikan kalau `REDIS_CLUSTER_NODES` diisi — dua mode ini eksklusif.

**BullMQ (queue) SENGAJA TIDAK ikut memakai mode cluster** — lihat
komentar lengkap di `shared/queue/connection.ts`. Ringkasnya: state
satu queue BullMQ butuh banyak key berada di hash slot yang sama,
membuat "cluster" untuk BullMQ pada praktiknya tidak benar-benar
mendistribusikan apa pun. Skalakan queue lewat concurrency/menambah
proses worker (lihat bagian "Advanced Queue Scaling" di bawah), bukan
Redis Cluster.

## Database Read Replica Support

**Env**: `DATABASE_REPLICA_URL` (opsional).

`prismaRead` (`shared/config/database.ts`) — client Prisma terpisah
untuk query BACA, otomatis fallback ke `prisma` (primary) kalau
`DATABASE_REPLICA_URL` tidak diisi.

**PERINGATAN REPLICATION LAG** — replica PostgreSQL standar bersifat
asynchronous. `prismaRead` HANYA aman untuk query yang tidak butuh
melihat tulisan yang baru saja terjadi di request yang sama. Lihat
komentar lengkap di `env.ts` (`DATABASE_REPLICA_URL`).

**Status penerapan saat ini**: `ProductRepository.findMany` adalah
REFERENCE IMPLEMENTATION pola ini (satu-satunya yang sudah
diterapkan). Method tulis (`create`/`update`/`delete`) di SEMUA
repository tetap memakai `prisma` primary. Menerapkan pola yang sama
ke `EventRepository`/`UserRepository`/dst adalah kandidat kerja
lanjutan — ikuti pola constructor `ProductRepository` (parameter kedua
opsional, default ke `prisma` yang sama) persis.

## Connection Pool Optimization

**Env**: `DATABASE_CONNECTION_LIMIT`, `DATABASE_POOL_TIMEOUT_SECONDS`
(keduanya opsional, default 0 = pakai default Prisma).

Di-append sebagai query parameter ke connection string
(`connection_limit`, `pool_timeout`) — cara resmi Prisma mengatur
ukuran pool koneksi PostgreSQL internal.

**PERHITUNGAN WAJIB sebelum mengubah nilai ini**: `jumlah instance API
× connection_limit` TIDAK BOLEH melebihi `max_connections` PostgreSQL
(default PostgreSQL: 100, dikurangi koneksi yang dipakai
superuser/replication/exporter). Kalau menjalankan 4 instance API
dengan `connection_limit=20`, itu sudah 80 koneksi — sisakan cukup
headroom untuk `postgres_exporter` (Phase 13) dan koneksi admin
manual. Pertimbangkan PgBouncer (connection pooler eksternal) di depan
PostgreSQL kalau jumlah instance API terus bertambah — di luar cakupan
implementasi fase ini, tapi arsitekturnya kompatibel (PgBouncer
transparan bagi Prisma selama mode `transaction`/`session` dipilih
sesuai kebutuhan fitur, cek dokumentasi Prisma soal batasan PgBouncer
`transaction` mode dengan prepared statement).

## Distributed Lock

`shared/concurrency/distributed-lock.ts` — `acquireLock`/`releaseLock`/
`withLock`, berbasis Redis (`SET NX PX` + Lua compare-and-delete untuk
release yang aman).

**KEJUJURAN SOAL BATASAN** (lihat juga komentar lengkap di file
tersebut): ini BUKAN implementasi algoritma Redlock penuh (yang
mensyaratkan mayoritas dari BEBERAPA instance Redis independen untuk
jaminan formal saat network partition). Cukup untuk "kurangi
kemungkinan kerja dobel" (dipakai scheduler, lihat di bawah), TIDAK
cukup untuk kebutuhan mutual-exclusion yang butuh jaminan matematis
ketat (mis. mencegah double-spend finansial — pakai lock level
database `SELECT ... FOR UPDATE` untuk itu).

**Dipakai di**: `shared/scheduler/job-runner.ts` — setiap scheduled
job dibungkus lock supaya worker AMAN di-scale ke beberapa instance
(lihat bagian "Horizontal Scaling Preparation" di bawah).

## Cache Manager

`shared/cache/cache-manager.ts` — LAPISAN DI ATAS `shared/utils/cache.ts`
(yang tetap dipakai apa adanya di seluruh codebase yang sudah
memakainya), menambah dua kapabilitas:

- **Tag-based invalidation** (`getOrSetCacheWithTags`/`invalidateTag`)
  — satu write yang mempengaruhi banyak variasi cache key sekaligus
  (mis. listing dengan kombinasi filter berbeda-beda) bisa
  diinvalidasi lewat SATU tag, tanpa perlu tahu daftar key persis di
  muka.
- **Stampede protection** (`getOrSetCacheWithStampedeProtection`) —
  saat satu key populer kedaluwarsa, distributed lock memastikan HANYA
  SATU request yang menjalankan `fetcher` (query berat); request lain
  menunggu sebentar lalu membaca hasil yang sama. Pakai ini HANYA
  untuk cache dengan traffic tinggi + fetcher mahal — untuk cache
  biasa, `getOrSetCache` polos sudah cukup (overhead koordinasi lock
  di sini tidak sepadan untuk fetcher yang murah).

**Belum dipakai di modul manapun secara default** — ini primitif baru
yang tersedia untuk dipakai; migrasi `FeatureFlagService`/
`TenantService` (yang saat ini memakai `getOrSetCache` polos) ke
tag-based invalidation adalah keputusan terpisah, TIDAK dilakukan
otomatis di fase ini supaya tidak mengubah perilaku fitur yang sudah
stabil tanpa alasan konkret.

## Advanced Queue Scaling

**Env**: `EMAIL_QUEUE_CONCURRENCY`, `NOTIFICATION_QUEUE_CONCURRENCY`
(default 5), `EMAIL_QUEUE_RATE_LIMIT_MAX`/`_DURATION_MS` (default 100
job/60 detik).

Dua lapisan kontrol berbeda tujuan (lihat komentar lengkap di
`workers/email.worker.ts`):
- `concurrency` — job paralel per PROSES worker.
- `limiter` — job yang boleh MULAI per satuan waktu, dihitung GLOBAL
  lintas semua instance worker yang membaca queue yang sama (BullMQ
  yang mengoordinasikannya lewat Redis, bukan per-proses).

Untuk throughput lebih tinggi lagi: naikkan `concurrency` (lebih
banyak job paralel per proses) DAN/ATAU jalankan lebih banyak proses
worker (`npm run worker` di beberapa container/instance — BullMQ
otomatis membagi job antar semua worker yang membaca queue yang sama,
tidak perlu konfigurasi tambahan untuk itu).

## Horizontal Scaling Preparation

Checklist status statelessness aplikasi ini:

| Komponen | Status | Catatan |
|---|---|---|
| Session/auth | ✅ Stateless | JWT + refresh token di database, bukan session in-memory |
| Token blacklist | ✅ Shared state | Database (`BlacklistedToken`), bukan in-memory |
| Login attempt lockout | ⚠️ Kondisional | Redis-backed KALAU `REDIS_URL` dikonfigurasi; fallback in-memory per-proses kalau tidak (lihat `login-attempt-tracker.ts`) — dengan Redis, aman multi-instance; tanpa Redis, TIDAK konsisten lintas instance |
| Scheduled jobs | ✅ Aman multi-instance (Phase 14) | Distributed lock (lihat di atas) — SELAMA `REDIS_URL` dikonfigurasi; tanpa Redis, lock fail-open dan worker kembali harus single-instance |
| Cache | ✅ Shared state | Redis, bukan in-memory |
| File upload | ✅ Stateless | Langsung ke S3 (Phase 4), tidak ada file lokal di disk container |
| Rate limiting | ✅ Shared state | `shared/security/rate-limiter.ts` sudah memakai `rate-limit-redis` sebagai store ketika `REDIS_URL` dikonfigurasi (fallback ke `MemoryStore` in-memory kalau tidak) — sudah aman multi-instance sejak sebelum Phase 14, diverifikasi ulang di fase ini. |

**Kesimpulan**: API server (`server.ts`) pada dasarnya SUDAH bisa
di-scale ke banyak instance di belakang load balancer, DENGAN SYARAT
`REDIS_URL` dikonfigurasi (untuk lockout/cache/rate-limit yang
konsisten lintas instance — ketiganya sudah Redis-backed, lihat tabel
di atas). Proses worker (`worker.ts`) sekarang JUGA bisa di-scale ke
banyak instance (Phase 14, lewat distributed lock), dengan syarat yang
sama.

## Menjalankan dengan fitur scalability aktif

```bash
# .env
REDIS_URL="redis://localhost:6379"                    # wajib untuk lockout/cache/lock konsisten multi-instance
DATABASE_REPLICA_URL="postgresql://...replica-host.../db"  # opsional
DATABASE_CONNECTION_LIMIT=20
EMAIL_QUEUE_CONCURRENCY=10
```

Menjalankan beberapa instance worker secara lokal untuk mengetes
distributed lock:

```bash
npm run worker    # terminal 1
npm run worker    # terminal 2 — job scheduler yang sama TIDAK akan jalan dobel di keduanya
```
