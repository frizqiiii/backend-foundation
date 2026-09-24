# Strategi Versioning API (Kelompok 2, item 2.12)

Dokumen ini punya tiga bagian yang SENGAJA dipisah supaya tidak tercampur:

1. **Keadaan sekarang** — fakta yang diperiksa langsung terhadap kode (bukan asumsi).
2. **Kebijakan (usulan)** — aturan main yang direkomendasikan. **Belum ada yang
   ditegakkan oleh kode**; ini keputusan pemilik project, bukan sesuatu yang otomatis
   berlaku hanya karena ditulis di sini.
3. **Celah yang diketahui** — hal yang belum ada dan tidak dikerjakan di item ini.

## 1. Keadaan sekarang (terverifikasi terhadap kode)

### Skema: versi mayor di path

Semua endpoint bisnis dipasang lewat SATU router di `/api/v1`
(`createV1Router()` di `src/app.ts`, dipasang dengan `app.use('/api/v1', createV1Router())`).
Tidak ada versioning lewat header (`Accept-Version`, `X-API-Version`) maupun query string.

| Kelompok | Di-versioning? | Keterangan |
|---|---|---|
| Semua modul bisnis (`auth`, `users`, `products`, `events`, `upload`, `feature-flags`, `dashboard`, `tenants`, `api-keys`, `webhooks`, `exports`, `reporting`, `analytics`, dst.) | Ya, `/api/v1/*` | |
| `/api/v1/internal/alertmanager-webhook` | Ya (secara teknis) | Dipanggil Alertmanager, bukan klien publik — lihat bagian 2.6 |
| `/health`, `/ready` | Tidak | Pemeriksaan infrastruktur; keputusan sadar, dijelaskan di komentar `app.ts` |
| `/metrics` | Tidak | Scrape target Prometheus |
| `/api-docs`, Bull Board, local storage | Tidak | Kontrak operasional / dokumentasi |

Middleware global (Helmet, CORS, `express.json`, sanitasi input, `verifyRequestOrigin`,
`tenantMiddleware`, logger, metrics) dipasang di level `app`, jadi berlaku untuk versi
mana pun. Rate limit per-versi dipasang oleh `createApiRouter()` (`generalRateLimiter` dan
`tenantRateLimiter`), yang menjadi titik awal setiap `createVNRouter()` (temuan T8); hanya
`authRateLimiter` untuk mount `/auth` yang masih dipasang manual per versi.

### Yang belum ada

- **Tidak ada mekanisme deprecation.** Tidak ada header `Deprecation`/`Sunset`, tidak ada
  middleware untuk itu (pencarian `deprecat`/`sunset` di `src/` tidak menemukan apa pun
  selain catatan tentang FCM legacy).
- **Nomor versi OpenAPI dan `package.json` tidak punya aturan hubungan.** Keduanya `1.0.0`;
  `servers` di OpenAPI hanya `/api/v1`.
- **Cakupan contract test sangat tipis.** Pact provider verification
  (`auth.provider.contract.spec.ts`, jalan di CI lewat `npm run test:contract`) hanya
  memuat 2 interaksi, keduanya `POST /api/v1/auth/login`, dengan satu konsumen
  (`frontend-web`). Perubahan breaking di endpoint lain TIDAK akan tertangkap oleh Pact.
- **Payload webhook keluar tidak membawa versi.** Header yang dikirim hanya
  `X-Webhook-Signature`, `X-Webhook-Timestamp`, `X-Webhook-Delivery-Id`
  (`src/shared/queue/webhook-delivery.queue.ts`). Bentuk payload berevolusi terpisah dari
  versi URL, tanpa penanda apa pun bagi penerima.

### Traffic per versi SUDAH bisa diukur

Label `route` pada metric HTTP dibentuk dari `req.baseUrl + req.route.path`
(`metrics.middleware.ts`), jadi prefix versi ikut tercatat (`/api/v1/users/:id`).
Diverifikasi lewat probe Express dengan pola mount yang sama: dua router yang sama
di `/api/v1` dan `/api/v2` menghasilkan label `/api/v1/users/:id` dan `/api/v2/users/:id`.
Contoh query untuk keputusan sunset:

```promql
sum by (route) (increase(http_requests_total{route=~"/api/v1/.*"}[7d]))
```

**Batasannya:** dimensi ini hanya per-route, BUKAN per tenant atau per API key. Kita bisa
tahu bahwa v1 masih dipakai, tapi tidak bisa tahu SIAPA yang masih memakainya dari metric
saja (perlu log, lihat celah G3).

### Titik kontrak yang bergantung pada path `/api/v1`

Ini yang membuat "ganti versi" tidak sesederhana menambah router:

| Titik | Lokasi | Siapa yang mengontrol |
|---|---|---|
| Callback SSO `{APP_BASE_URL}/api/v1/auth/sso/:tenantSlug/callback` | `sso.service.ts` | **Pihak luar**: URL ini didaftarkan di IdP tiap tenant |
| Webhook Alertmanager `/api/v1/internal/alertmanager-webhook` | `monitoring/alertmanager/alertmanager.yml` | Kita sendiri (internal) |
| Pact `frontend-web` | `pacts/frontend-web-backend-foundation.json` | Tim frontend |
| Skrip k6 | `performance-tests/*.js` | Kita sendiri |

## 2. Kebijakan (usulan — belum ditegakkan kode)

### 2.1. Apa yang butuh versi mayor baru

**Breaking (wajib `/api/v2`, jangan ubah `/api/v1`):**
menghapus/mengganti nama field respons atau parameter; mengubah tipe field; mengubah
arti field yang sudah ada; membuat parameter opsional menjadi wajib; menghapus endpoint;
mengubah kode status atau format error untuk kasus yang sudah ada; memperketat validasi
sehingga input yang dulu lolos kini ditolak; mengubah aturan autentikasi/otorisasi endpoint
yang sudah ada.

**Non-breaking (boleh langsung di v1):**
menambah endpoint baru; menambah field BARU pada respons; menambah parameter opsional;
menambah nilai enum baru **hanya jika** klien sudah didokumentasikan untuk menoleransi
nilai tak dikenal (kalau tidak, perlakukan sebagai breaking); memperbaiki bug yang membuat
perilaku sesuai dokumentasi.

**Konsekuensi:** klien harus diberi tahu (di dokumentasi) bahwa mereka WAJIB mengabaikan
field respons yang tidak dikenal. Tanpa aturan itu, "menambah field" pun bisa merusak.

### 2.2. Hanya versi mayor

Format `/api/v{N}` dengan bilangan bulat. Tidak ada `/v1.1`. Perubahan aditif tetap di v1
dan dicatat di CHANGELOG (item 3.4, belum ada).

### 2.3. Jendela dukungan (angka adalah usulan awal, sesuaikan dengan target B2B)

- Paling banyak **2 versi mayor** hidup bersamaan.
- Deprecation diumumkan minimal **6 bulan** sebelum sunset (naikkan ke 12 bulan kalau ada
  klien B2B dengan siklus rilis lambat).
- Sunset hanya boleh dilakukan kalau traffic route v lama sudah mendekati nol (query
  PromQL di atas) DAN klien yang tersisa sudah dihubungi.

### 2.4. Sinyal deprecation (standar HTTP)

Saat sebuah versi dinyatakan deprecated, setiap respons dari versi itu membawa:

```
Deprecation: @<unix-timestamp-tanggal-deprecation>
Sunset: <tanggal HTTP, mis. Tue, 30 Jun 2027 23:59:59 GMT>
Link: <https://…/docs/api-versioning>; rel="deprecation",
      <https://…/api/v2/…>; rel="successor-version"
```

Acuan: RFC 9745 (`Deprecation`, Standards Track, Maret 2025) dan RFC 8594 (`Sunset`).
Tanggal `Sunset` tidak boleh lebih awal dari tanggal `Deprecation`. Setelah tanggal sunset
lewat, respons yang wajar adalah `410 Gone` beserta `Link` ke penggantinya.
Ingat: header ini hanya PEMBERITAHUAN — perilaku endpoint tidak berubah.

### 2.5. Cara menambahkan `/api/v2` secara teknis

1. Buat `createV2Router()` di samping `createV1Router()` dan pasang di `/api/v2`. Jangan
   ubah router v1.
2. **Mulai `createV2Router()` dari `createApiRouter()`, BUKAN `Router()` polos.**
   `createApiRouter()` (di `src/app.ts`) sudah memasang `generalRateLimiter` dan
   `tenantRateLimiter`, jadi router v2 terlindungi sejak dibuat (temuan T8; sebelumnya kedua
   limiter itu tertanam di `createV1Router()` dan router v2 "serupa v1" tidak terlindungi
   tanpa peringatan apa pun). Dua penjaga mencegah kemunduran:
   `src/api-router.guard.spec.ts` (gagal kalau ada mount `/api/vN` yang factory-nya tidak
   dimulai dari `createApiRouter()`) dan `src/app.api-router.integration.spec.ts` (perilaku
   nyata, termasuk kontrol negatif: `Router()` polos terbukti tidak terlindungi — 320 request
   semuanya lolos). Karena kedua limiter singleton level modul, kuota per-IP/per-tenant
   dihitung GABUNGAN lintas versi (terbukti: 150 request di v1 + 150 di v2 menghabiskan jatah
   300; klien tidak bisa melipatgandakan jatahnya dengan berpindah versi). Kalau kuota mau
   dipisah per versi, buat instance limiter baru dengan `keyPrefix` berbeda.
   **Yang masih manual:** `authRateLimiter` pada mount `/auth` (lebih ketat, mencegah
   brute-force login) tidak ikut `createApiRouter()` — versi baru yang memasang `/auth` HARUS
   memakainya (`v2Router.use('/auth', authRateLimiter, ...)`); belum ada penjaga otomatis untuk itu.
3. Modul yang tidak berubah antar versi boleh dipasang di kedua router (router modul yang
   sama). Hanya modul yang berubah yang perlu implementasi v2.
4. Dokumentasi: `servers` OpenAPI sekarang hanya `/api/v1`. Untuk v2 perlu spec terpisah
   (atau spec kedua di Swagger UI) — satu dokumen tidak bisa menjelaskan dua kontrak
   yang saling bertabrakan dengan benar.
5. Tambahkan interaksi Pact untuk endpoint yang berubah (lihat G2).

### 2.6. Path yang membeku (frozen) sampai koordinasi dengan pihak luar

- **`/api/v1/auth/sso/:tenantSlug/callback`**: URL ini didaftarkan di IdP masing-masing
  tenant (Okta, Azure AD, dst.). `SsoService` mengirimnya sebagai `redirect_uri` di setiap
  login dan tukar-kode, dan IdP hanya mengembalikan pengguna ke URL yang SUDAH terdaftar.
  Mengubah path yang dikirim, atau mematikan path yang dilayani, membuat SEMUA tenant SSO gagal
  login sampai masing-masing admin mendaftarkan URL baru di IdP-nya — di luar kendali kita.

  **Kontrak ini sudah dikunci oleh test** (temuan T7): `src/app.sso-callback-contract.integration.spec.ts`
  memastikan (1) path yang dikirim ke IdP persis `/api/v1/auth/sso/:tenantSlug/callback`, dan (2) path
  itu benar-benar dilayani aplikasi. Dibuktikan dengan dua mutasi: menaikkan URL yang dikirim ke
  `/api/v2` membuat kedua pemeriksaan gagal, dan mencabut route callback membuat pemeriksaan
  "dilayani" gagal. Kalau test itu gagal, jangan mengubah test-nya — putuskan dulu bagaimana tenant
  SSO yang ada dimigrasikan.

  **KEPUTUSAN (T7, diambil): Opsi A — pertahankan path beku.** Saat `/api/v1`
  suatu saat dinyatakan sunset (BELUM terjadi — lihat catatan eksekusi di
  bawah), sisakan router `/api/v1` MINIMAL yang hanya memuat
  `/auth/sso/:tenantSlug/login`, `/auth/sso/:tenantSlug/callback`, dan
  `/auth/sso/consume` (dibuat dari `createApiRouter()` dan memakai
  `authRateLimiter`, lihat 2.5), sementara sisa v1 mengembalikan `410 Gone`.
  Nol pekerjaan bagi tenant existing; biayanya satu router kecil yang hidup
  selamanya dan kewajiban tetap merawat tiga endpoint itu. Dipilih di atas
  B (migrasi tenant — butuh koordinasi ke tiap admin tenant mendaftarkan
  `redirect_uri` baru di IdP-nya, tenggat yang tidak bisa kita paksakan,
  dan risiko terbesar: tenant yang telat migrasi = SEMUA user tenant itu
  gagal login) dan C (alias tak-berversi — cuma menyelesaikan tenant BARU,
  tidak menyelesaikan yang sudah terdaftar sama sekali). Prinsip yang sama
  dengan keputusan desain lain di project ini (mis. DR/T19, CI/T9): lebih
  baik gagal aman & dapat diprediksi daripada elegan tapi bergantung
  koordinasi pihak luar yang tidak bisa dijamin.

  **CATATAN EKSEKUSI — BELUM ada yang perlu dikerjakan sekarang.** Keputusan
  di atas adalah kebijakan untuk SAAT `/api/v1` disunset — dan `/api/v2`
  sendiri BELUM PERNAH dibangun (§2.5 masih panduan "cara menambahkan",
  bukan implementasi). Menjalankan Opsi A sekarang berarti mematikan
  SELURUH v1 aktif tanpa ada v2 sebagai penggantinya bagi klien — itu bukan
  sunset, itu merusak API yang masih dipakai. Opsi A baru dieksekusi sebagai
  kode NANTI, di titik `/api/v2` benar-benar mulai dibangun dan sunset v1
  sungguhan direncanakan. Sampai saat itu, satu-satunya perilaku yang
  dijamin tetap yang dikunci test di atas (T7) — tidak ada perubahan kode
  dari keputusan ini.
- **`/api/v1/internal/alertmanager-webhook`**: internal, tapi hardcoded di
  `alertmanager.yml`. Kalau v1 dimatikan, ubah konfigurasi Alertmanager dulu.

### 2.7. Payload webhook keluar

Versi payload webhook adalah kontrak TERPISAH dari versi URL API. Usulan (aditif, jadi
boleh masuk v1): tambah header `X-Webhook-Version` (atau field `apiVersion` di body) yang
menyatakan versi payload. Perubahan breaking pada payload = versi payload baru, dikirim
hanya ke endpoint yang memilihnya. **Belum diimplementasikan.**

### 2.8. Prosedur sunset (checklist)

1. Umumkan di dokumentasi dan ke klien yang diketahui; tetapkan tanggal.
2. Aktifkan header `Deprecation`/`Sunset`/`Link` di seluruh respons versi lama.
3. Pantau traffic route versi lama (PromQL di atas) mingguan.
4. Hubungi klien yang masih aktif mendekati tanggal sunset (butuh log untuk tahu siapa, G3).
5. (Opsional) brownout singkat terjadwal — kembalikan `410` beberapa menit — untuk memunculkan
   klien yang mengabaikan header.
6. Setelah tanggal sunset: `410 Gone` dengan `Link` ke penggantinya; hapus kode setelah
   masa tenggang. Pastikan path beku (2.6) sudah ditangani.

## 3. Celah yang diketahui (tidak dikerjakan di item 2.12)

Item 2.12 hanya dokumentasi. Berikut yang harus dibangun kalau kebijakan di atas dipakai:

| ID | Celah | Catatan |
|---|---|---|
| G1 | Middleware deprecation (`Deprecation`/`Sunset`/`Link`) | Per-router, dikonfigurasi lewat tanggal; mudah dites unit |
| G2 | Cakupan Pact hanya `POST /auth/login` | Tambah interaksi untuk endpoint yang dipakai konsumen nyata |
| G3 | Metric tanpa dimensi tenant/API key | Untuk tahu siapa yang masih di v1: log terstruktur per request (tenantId/apiKeyId) atau label bercardinality rendah |
| G4 | ~~Middleware umum API hidup di `createV1Router()`~~ | **Selesai (T8):** `createApiRouter()` + penjaga. Sisa: `authRateLimiter` di `/auth` masih manual per versi |
| G5 | Payload webhook tanpa versi | Bagian 2.7 |
| G6 | Tidak ada aturan versi OpenAPI/`package.json` | Usulan: `info.version` OpenAPI mengikuti perubahan aditif (minor), path mengikuti mayor |
| G7 | Belum ada `CHANGELOG.md` | Roadmap 3.4; tempat mencatat perubahan aditif dan deprecation |
| G8 | Path SSO callback terikat `/api/v1` | **Dikunci test** (T7, bagian 2.6). Sisa: keputusan opsi A/B/C sebelum sunset pertama |

## 4. Status verifikasi dokumen

Semua pernyataan di bagian 1 diperiksa terhadap kode pada snapshot repo saat dokumen ini
ditulis (pembacaan `app.ts`, `metrics.middleware.ts`, `sso.service.ts`,
`webhook-delivery.queue.ts`, `ci.yml`, `pacts/`, pencarian `deprecat`/`sunset`/`/api/v1`).
Klaim label `route` diverifikasi dengan probe Express di sandbox (bukan di environment
produksi/Prometheus sungguhan). Bagian 2 adalah usulan kebijakan, bukan perilaku sistem.
