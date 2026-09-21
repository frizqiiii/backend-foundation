# Secrets Management (Kelompok 2, item 2.4)

## Desain

`scripts/sync-secrets-from-vault.js` mengambil secret dari HashiCorp
Vault (KV v2 engine) lewat `node-vault` (client library resmi/vetted
dari npm, bukan tulisan sendiri) dan menuliskannya ke `.env` —
dijalankan **sebelum** `pm2 reload` di `deploy/scripts/deploy.sh`,
opsional (cuma jalan kalau `VAULT_ADDR` diisi).

**Kenapa pola sync-ke-file, bukan app connect ke Vault langsung saat
runtime**: `env.ts` memvalidasi `process.env` secara SINKRON di titik
import pertama (`cleanEnv(...)`). Membuat app fetch dari Vault
langsung berarti proses itu harus ASYNC, yang berarti merombak urutan
bootstrap `server.ts`/`worker.ts` yang sudah establish & sensitif
(lihat komentar "HARUS jadi import PALING PERTAMA" di
`tracing.ts`) — risiko terlalu besar untuk manfaat yang didapat.
Pola sync-ke-file ini justru yang dipakai banyak deployment Vault
sungguhan (mis. Vault Agent, init container Kubernetes): Vault jadi
SUMBER KEBENARAN untuk secret, tapi aplikasi itu sendiri tetap baca
`process.env` biasa tanpa tahu-menahu soal Vault — **nol perubahan**
ke `env.ts` atau urutan bootstrap yang sudah teruji.

**Fail-closed (BUKAN fail-open)** — beda dari filosofi cache/rate-limiter
di aplikasi ini yang sengaja fail-open kalau Redis down: kalau Vault
tidak terjangkau/token salah/path tidak ada/secret kosong, script
berhenti exit code 1 **tanpa menyentuh `.env` sama sekali**. Karena
`deploy.sh` pakai `set -euo pipefail`, kegagalan ini otomatis
menghentikan seluruh proses deploy SEBELUM `pm2 reload` sempat jalan
dengan `.env` yang basi/tidak lengkap.

## Temuan audit T17: script sync menulis secret dengan salah dan tidak aman (sudah diperbaiki)

Audit `scripts/sync-secrets-from-vault.js` dengan menjalankannya sungguhan (script asli, klien `node-vault` asli, server
tiruan KV v2, hasilnya dibaca ulang dengan `dotenv` v16, parser yang dipakai aplikasi) menemukan empat masalah. Verifikasi
15/15 di bagian bawah hanya memakai nilai sederhana, sehingga tidak menyentuh ini.

1. **Nilai berisi `"` atau `\` berubah diam-diam.** Script memakai `JSON.stringify`, padahal `dotenv` v16 hanya mengekspansi
   `\n` dan `\r` di dalam kutip ganda; `\"` dan `\\` tidak di-unescape. `pa"ss` terbaca `pa\"ss` dan `a\b` terbaca `a\\b`
   (2 dari 10 nilai uji), tanpa error apa pun saat sync. Password database atau token dengan karakter itu akan gagal
   di runtime, dan penyebabnya sulit dilacak karena Vault sendiri benar.
   **Perbaikan:** kutip tunggal (literal murni, tanpa escape dan interpolasi, di `dotenv` maupun `env_file` Compose)
   untuk semua nilai tanpa `'`; nilai dengan `'` memakai kutip ganda hanya bila tidak butuh escape/interpolasi; kombinasi
   yang tidak bisa ditulis benar di kedua parser **ditolak** (fail-closed), bukan ditulis salah.
2. **`.env` dibuat dengan izin 0644** (`umask 022`), terbaca semua user di VPS. **Perbaikan:** izin `0600`, juga untuk `.env`
   lama yang diganti.
3. **Nama key dari Vault ditulis apa adanya**: key berisi newline menyuntikkan baris baru (key `FOO\nNODE_ENV` menghasilkan
   `NODE_ENV="production"` yang dibaca `dotenv`). Penulis Vault bisa dipercaya, tetapi key yang salah ketik atau pipeline CI
   yang menulis ke Vault tidak seharusnya bisa mengubah variabel lain. **Perbaikan:** nama key harus
   `^[A-Za-z_][A-Za-z0-9_]*$`, kalau tidak sync berhenti dan `.env` tidak disentuh.
4. **Penulisan tidak atomik** (`writeFileSync` memotong file lalu menulis): proses yang mati di tengah jalan meninggalkan
   `.env` terpotong, bertentangan dengan janji fail-closed di atas. **Perbaikan:** tulis ke file sementara di direktori yang
   sama lalu `rename`.

Tambahan: peringatan (bukan penolakan) bila `VAULT_ADDR` memakai `http://` ke host non-lokal, karena `VAULT_TOKEN` dan
secret terkirim tanpa enkripsi.

**Batas yang tetap jujur:** perilaku parser `env_file` Docker Compose TIDAK diuji di sini (tidak ada Docker). Pemilihan kutip
tunggal didasarkan pada spesifikasi Compose (nilai berkutip tunggal literal, tanpa interpolasi), bukan pada percobaan.
Verifikasi terhadap Vault sungguhan tetap tugasmu (lihat "Verifikasi terhadap Vault ASLI").

## Batasan jujur — Vault yang diuji di sini BUKAN Vault asli

`releases.hashicorp.com` (satu-satunya sumber binary resmi Vault)
tidak terjangkau dari sandbox AI ini, dan HashiCorp tidak
mendistribusikan Vault lewat GitHub releases. Jadi verifikasi di
bawah dijalankan terhadap **mock server buatan sendiri** yang meniru
KETAT format response asli KV v2 Vault (didokumentasikan publik &
stabil oleh HashiCorp) — BUKAN Vault sungguhan.

Yang tetap memberi keyakinan nyata meski begitu: **client library-nya
ASLI** (`node-vault` dari npm, dipakai luas, bukan HTTP call yang saya
tulis manual) — jadi yang teruji adalah kode integrasi
(`sync-secrets-from-vault.js`) memakai library asli dengan benar,
bukan asumsi saya sendiri soal bagaimana Vault "seharusnya"
merespons.

**Perlu diverifikasi ulang** terhadap Vault sungguhan di komputermu
sendiri (tidak kena batasan network seperti sandbox ini) — lihat
"Verifikasi terhadap Vault ASLI" di bawah.

## Verifikasi yang sudah dijalankan (mock, sandbox)

15/15 pengecekan lolos, stabil 3x run:

1. **Sync sukses** — `.env` yang sudah ada dipertahankan barisnya
   (`PORT`, `NODE_ENV`), secret dari Vault (`DATABASE_URL`,
   `JWT_SECRET`, `ENCRYPTION_KEY`) ditambahkan dengan benar.
2. **Sync KEDUA** — key yang sama ditimpa DI TEMPAT, tidak duplikat
   baris (penting untuk idempotency — deploy berkali-kali tidak bikin
   `.env` membengkak).
3. **Token salah** — ditolak (403 dari mock), `.env` **tidak berubah
   sama sekali**.
4. **Path secret tidak ada** — ditolak (404), `.env` tidak berubah.
5. **Vault tidak terjangkau** — gagal cepat dengan exit code jelas
   (bukan hang tak terkendali).
6. **`VAULT_TOKEN` tidak diset** — ditolak SEBELUM sempat request ke
   Vault sama sekali (validasi input duluan).

## Verifikasi terhadap Vault ASLI (jalankan di komputermu)

Vault punya mode dev yang jalan dalam hitungan detik, bisa langsung
kamu coba (di luar sandbox saya, tidak ada batasan network):

```cmd
:: Download dari https://developer.hashicorp.com/vault/downloads (Windows amd64),
:: extract vault.exe, lalu:

vault server -dev -dev-root-token-id="root-token-asli"
```

Di terminal LAIN (biarkan server di atas tetap jalan):
```cmd
set VAULT_ADDR=http://127.0.0.1:8200
set VAULT_TOKEN=root-token-asli
vault kv put secret/backend-foundation DATABASE_URL="postgresql://..." JWT_SECRET="secret-asli-32-karakter-lebih" ENCRYPTION_KEY="..."

cd C:\Users\user\Downloads\backend-foundation-project-v16
set VAULT_SECRET_PATH=secret/data/backend-foundation
npm run secrets:sync
type .env
```

Kalau `.env` ter-update dengan nilai yang sama seperti yang kamu
`vault kv put` di atas — integrasi ini terverifikasi PENUH terhadap
Vault sungguhan, menutup satu-satunya celah yang sandbox saya tidak
bisa tutup sendiri.

## Yang belum tercakup (scope sadar)

- Autentikasi ke Vault di sini pakai token statis (`VAULT_TOKEN`) —
  untuk production sungguhan, AppRole auth (role_id + secret_id,
  token berumur pendek) lebih aman daripada token statis yang perlu
  disimpan di suatu tempat juga. Belum diimplementasikan di iterasi
  ini.
- Tidak ada rotasi OTOMATIS tanpa restart — sync ini jalan sekali per
  deploy, bukan polling berkala. Kalau secret diganti di Vault
  DI ANTARA dua deploy, app tidak otomatis tahu sampai deploy
  berikutnya.
- AWS Secrets Manager/Doppler (alternatif yang disebut roadmap) belum
  diimplementasikan — Vault dipilih karena paling bisa dibuktikan
  nyata (open-source, bisa dijalankan siapa pun), bukan berarti
  pilihan yang secara objektif "terbaik" untuk semua kasus.
