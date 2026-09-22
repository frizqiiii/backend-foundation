# Chaos Engineering (Kelompok 2, item 2.7)

## Metodologi

`chaos-test/harness-server.ts` adalah Express app MINIMAL yang
memakai KODE ASLI project ini (`createRateLimiter`, `getOrSetCache`,
`redisClient` — bukan tiruan/mock) tanpa menyentuh Prisma sama sekali
(rute-nya pakai fungsi compute in-memory, bukan query database) —
supaya bisa dijalankan penuh di sandbox mana pun (termasuk yang tidak
punya Prisma Client ter-generate).

`chaos-test/run-chaos-redis.js` menjalankan harness itu, mengirim
traffic HTTP **sungguhan** terus-menerus (tiap 150ms), lalu:
1. Mematikan Redis **sungguhan** (`redis-cli shutdown nosave`) di
   tengah traffic berjalan.
2. Membiarkan traffic terus jalan 4 detik dengan Redis mati.
3. Menyalakan Redis lagi, mengukur waktu pemulihan otomatis (TANPA
   restart proses app).

## Hasil — bug reliability nyata ditemukan & diperbaiki

**Sebelum fix**: traffic macet parah saat Redis mati — cuma 1 request
lolos dalam 4 detik (harusnya ~26), latency memburuk dari 606ms →
2400ms → 3000ms+ command demi command. Ini KONTRADIKTIF dengan tujuan
yang eksplisit ditulis di komentar `redis.ts` sendiri ("jangan pernah
membuat request HTTP menunggu retry Redis berkali-kali").

**Root cause** (diverifikasi lewat isolasi manual `ioredis`, bukan
tebakan): `maxRetriesPerRequest: 2` membuat command MENUNGGU siklus
reconnect background (`retryStrategy`) sebelum menyerah — dan delay
`retryStrategy` lama (`Math.min(times * 200, 1000)`) MEMBESAR seiring
banyaknya percobaan reconnect gagal. Command yang datang belakangan
(saat siklus reconnect sedang berjalan dengan delay besar) ikut
menunggu SISA delay itu — bukan langsung gagal seperti niat awal
desainnya.

**Fix** (`src/shared/config/redis.ts`):
- `maxRetriesPerRequest: 2` → **`0`** — command gagal SEKETIKA, tidak
  pernah menunggu reconnect sama sekali.
- `retryStrategy` — dari MEMBESAR (`times * 200`, maks 1 detik) jadi
  **KONSTAN 200ms** — reconnect di background tetap jalan terus,
  tapi delay-nya tidak lagi ikut menghukum command yang datang
  belakangan.

**Sesudah fix** — diverifikasi ulang, stabil 3x run:
- 6 request lolos selama 4 detik Redis mati (naik dari 1).
- Semua traffic tetap 200 OK selama Redis mati (fail-open beneran).
- Latency maksimum terkendali (~746-748ms, turun drastis dari 3000ms+).
- Pemulihan otomatis ~252ms setelah Redis hidup lagi, TANPA restart.

Test regresi ditambahkan (`src/shared/config/redis.spec.ts`) supaya
bug yang SAMA tidak bisa lolos lagi tanpa drill manual berulang.

## TEMUAN T21 (audit ulang) — mode Redis Cluster TIDAK ikut kena fix di atas, jauh lebih parah

Drill di atas hanya menguji cabang single-instance (`env.REDIS_URL`).
Audit ulang menemukan cabang Redis Cluster (`env.REDIS_CLUSTER_NODES`,
Fase 14 — Enterprise Scalability) masih memakai konfigurasi LAMA yang
belum diperbaiki (`maxRetriesPerRequest: 2`, tanpa `clusterRetryStrategy`
atau `enableOfflineQueue` sendiri) — kontradiktif dengan komentar file
`redis.ts` sendiri yang bilang kedua mode berbagi perilaku yang sama.

**Dibuktikan nyata** (cluster Redis 3-node sungguhan di sandbox — bukan
mock — dibuat dengan `redis-cli --cluster create`, harness pakai
`ioredis` `Cluster` dengan konfigurasi PERSIS sama seperti
`redis.ts`): setelah SELURUH node cluster dimatikan sungguhan, satu
command `GET` **tidak pernah resolve** (dites >15 detik, tidak pernah
resolve maupun reject), dan di bawah traffic HTTP kontinu setiap
request macet 5+ detik (dibatasi client timeout saya, latensi
sesungguhnya lebih lama lagi) — **JAUH lebih parah** dari bug
single-instance yang sudah diperbaiki (yang "cuma" melambat sampai
~3 detik, tidak pernah hang total). Akar masalah (diverifikasi lewat
probe terisolasi): `enableOfflineQueue` default `true` pada ioredis
Cluster membuat command masuk antrean menunggu cluster "ready", dan
`clusterRetryStrategy` bawaan ioredis TIDAK PERNAH menyerah (retry
selamanya) — jadi antrean itu tidak pernah di-flush, kontradiktif
total dengan tujuan fail-open.

**Fix** (`src/shared/config/redis.ts`, cabang Cluster): `maxRetriesPerRequest: 0`
(sama seperti single-instance), `clusterRetryStrategy: () => 200` (delay
konstan, sama filosofinya), dan **`enableOfflineQueue: false`** (baru —
tidak ada padanannya di cabang single-instance karena ioredis single-
instance tidak punya antrean cluster-level seperti ini) — command yang
datang saat cluster belum/tidak ready langsung ditolak, tidak diam-diam
diantre tanpa batas waktu.

**Sesudah fix, diverifikasi ulang nyata** (cluster 3-node yang sama):
- Matikan seluruh node → command ditolak dalam <1ms (bukan hang),
  10 request traffic berturut-turut semuanya langsung fail-open
  (bukan macet).
- Nyalakan cluster lagi → pulih otomatis ~258ms, TANPA restart proses.

Test regresi ditambahkan (`src/shared/config/redis.spec.ts`, 3 test
baru untuk cabang Cluster) — dijalankan 5x berturut-turut di sandbox,
stabil 5/5. **Batas kecil yang jujur diakui**: ketiga test Cluster ini
memicu peringatan non-fatal Jest ("did not exit one second after...")
karena `ioredis` `Cluster` menyisakan timer latar belakang sesaat
meski sudah `disconnect()` — TIDAK mempengaruhi hasil test (exit code
tetap 0, 5/5 lolos konsisten di banyak run), murni kosmetik di log CI.

**BELUM diverifikasi**: perilaku ini di komputer/CI kamu (baru diuji
di sandbox AI ini); dan skenario cluster PARSIAL mati (mis. 1 dari 3
node down, bukan semuanya) — drill di atas hanya menguji cluster mati
TOTAL, karena itu yang paling dekat dengan skenario "Redis mati" yang
sama seperti drill single-instance.

## Postgres chaos — BELUM tercakup penuh (butuh environment kamu)

Sandbox AI ini tidak bisa menjalankan Express app yang sesungguhnya
(butuh Prisma Client ter-generate, terblokir permanen di sini — lihat
catatan di berbagai bagian lain project ini). Jadi skenario "matikan
Postgres di tengah traffic nyata lewat app sesungguhnya" **belum
diverifikasi** seperti Redis di atas.

**Cara kamu menjalankannya sendiri** (di komputermu, Prisma Client
sudah ter-generate):
```cmd
npm run dev
:: di terminal LAIN, kirim traffic terus-menerus ke endpoint apa pun
:: yang menyentuh database (mis. GET /api/v1/events), lalu:
net stop postgresql-x64-16
:: amati response-nya -- HARUSNYA 503 jelas (readiness check gagal),
:: BUKAN hang/crash proses. Lalu:
net start postgresql-x64-16
:: amati app pulih otomatis tanpa restart proses Node.
```

## Cara menjalankan ulang drill Redis ini kapan saja

```bash
# Pastikan Redis jalan dulu (redis-cli ping -> PONG)
node chaos-test/run-chaos-redis.js
```

Tidak butuh Postgres/Prisma sama sekali — aman dijalankan di
environment mana pun yang punya Node + Redis.
