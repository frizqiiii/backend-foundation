# Mutation Testing (Phase 21 — Enterprise Quality)

Memakai [StrykerJS](https://stryker-mutator.io/) (`stryker.conf.json` di root) — bukan sekadar mengukur *coverage* (baris mana yang dieksekusi test), tapi mengukur **kualitas assertion**: Stryker mengubah kode secara sengaja (mis. `if (x > 5)` jadi `if (x >= 5)`, `return true` jadi `return false`) lalu menjalankan test suite; kalau tidak ada test yang gagal walau kode sudah "dirusak", itu tandanya test yang meng-cover baris itu tidak benar-benar memverifikasi perilakunya (coverage tinggi, tapi assertion lemah).

## Kenapa scope dibatasi ke `shared/reliability/` + `shared/utils/`

**BUKAN terlewat — keputusan sadar**, dua alasan:

1. **Runtime**: mutation testing pada dasarnya menjalankan SELURUH test suite berkali-kali (satu run penuh per mutant yang dihasilkan) — untuk codebase 200+ file, itu bisa berjam-jam. Scope penuh tidak praktis dijalankan reguler di CI tanpa infrastruktur khusus (runner ter-paralelisasi, caching agresif).
2. **Independensi dari Prisma Client**: `shared/reliability/` (timeout/retry/circuit-breaker/bulkhead, Phase 18) dan `shared/utils/` (CSV/XLSX/PDF generator, Phase 19) adalah **satu-satunya bagian besar aplikasi ini yang tidak mengimpor tipe `@prisma/client` sama sekali** — mutation testing pada file yang bergantung ke Prisma Client butuh `npx prisma generate` berhasil lebih dulu (sama seperti seluruh isu compile lain di project ini yang sudah didokumentasikan di `jest.config.ts`), menambah satu titik kegagalan lagi untuk scope awal ini.

Kedua modul ini juga **cocok secara alami** untuk mutation testing: logic murni, banyak percabangan kondisional (persis yang coverage biasa gampang salah kira "sudah teruji").

## Memperluas scope

Setelah pilot ini terbukti berguna, perluas bertahap lewat `stryker.conf.json` → `mutate`:
```json
"mutate": [
  "src/shared/reliability/**/*.ts",
  "src/shared/utils/**/*.ts",
  "src/modules/auth/**/*.ts",
  "!src/**/*.spec.ts"
]
```
Tambah satu modul dalam sekali waktu, ukur berapa lama run-nya bertambah, sebelum menambah modul berikutnya — bukan langsung ke scope penuh.

## Menjalankan

```bash
npm run test:mutation
```

Laporan HTML dihasilkan di `reports/mutation/html/index.html` (lihat konfigurasi `reporters` di `stryker.conf.json`).

## Threshold

- `high: 80` — mutation score ≥80% dianggap baik (ditampilkan hijau di laporan)
- `low: 60` — 60-80% dianggap perlu perbaikan (kuning)
- `break: 50` — **di bawah 50%, `stryker run` keluar dengan exit code bukan-nol** (bisa dipakai sebagai gate CI kalau/ketika dijadikan job wajib)

## Status verifikasi

**Belum pernah dijalankan** di lingkungan mana pun sampai catatan ini ditulis — konfigurasi disusun berdasarkan dokumentasi resmi Stryker, tapi belum divalidasi end-to-end (sandbox penyusun tidak punya akses jaringan untuk mengunduh binary yang mutation testing butuhkan). **Jalankan `npm run test:mutation` di lingkungan Anda sebelum mengandalkan hasilnya** — kemungkinan ada penyesuaian konfigurasi kecil yang baru ketahuan saat run sungguhan pertama kali.
