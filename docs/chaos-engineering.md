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
