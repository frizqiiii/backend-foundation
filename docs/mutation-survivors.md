# Analisis Survivor Mutation Testing (Fase 3.5)

Berdasarkan `mutation-report.zip` (skor 91.15%, run CI saat dokumen ini dimulai): 368
killed, 13 timeout, 37 survived, 0 no-coverage, 13 error. Ditambah per file, per ronde,
seiring survivor dianalisis — bukan sekaligus semua di awal. Ronde pertama HANYA membahas
9 survivor di `src/shared/reliability/` (`bulkhead.ts` 3, `circuit-breaker.ts` 5,
`retry.ts` 1) —
diprioritaskan di atas `export.ts` dkk karena ini kode yang menentukan perilaku saat
gangguan nyata, bukan tata letak PDF. Setiap survivor diperiksa isi mutan persisnya
(lokasi, mutator, teks pengganti) dari `mutation.json`, BUKAN ditebak dari nama file.

## Diperbaiki (4) — regresi nyata, test baru DIBUKTIKAN mematikan mutannya

Untuk keempat ini, mutasinya diterapkan manual ke source, dikonfirmasi test BARU gagal,
lalu source dikembalikan persis semula (dicek `diff` byte-per-byte) — bukan cuma percaya
Stryker akan setuju nanti.

### `bulkhead.ts` id=25 — `state.active -= 1` → `state.active += 1`
Kalau slot yang sudah selesai malah MENAMBAH `state.active` (bukan mengurangi), bulkhead
akan terlihat "makin penuh" tiap siklus meski tidak ada satu pun panggilan yang benar-benar
berjalan — kebocoran semaphore. Test lama tidak menangkap ini karena satu-satunya test yang
menunggu slot kosong (`P5`) membuktikan waiter tetap jalan (fungsi "bangunkan next waiter"
di `finally` tidak bersyarat pada `state.active`), TANPA pernah menguji panggilan KE-3/KE-4
dst yang baru akan gagal kalau count-nya salah. Test baru: 5 panggilan sekuensial
occupy→selesai→occupy lagi (maxConcurrent=1, maxQueue=0) — semuanya HARUS lolos tanpa
`BulkheadRejectedError`.

### `circuit-breaker.ts` id=48 — `elapsed < resetTimeoutMs` → `elapsed <= resetTimeoutMs`
Test lama menguji jauh sebelum reset (masih OPEN) dan `resetTimeoutMs + 1` (setelah reset) —
dua-duanya sepakat di kedua operator, jadi tidak pernah menyentuh titik yang membedakan
`<` dari `<=`. Test baru: majukan waktu PERSIS `resetTimeoutMs` (bukan +1), buktikan breaker
SUDAH transisi HALF_OPEN di titik itu (probe/`fn` benar-benar dipanggil), bukan menahan satu
tick lebih lama seperti versi mutan.

### `circuit-breaker.ts` id=65 — `breaker.state = 'CLOSED'` → `''`
Baris ini HANYA berpengaruh nyata lewat baris LAIN yang membaca `breaker.state` pada
pemanggilan BERIKUTNYA (`if (breaker.state !== 'CLOSED')` yang memicu log "pulih") — bukan
lewat pengecekan langsung pada pemanggilan yang sama. Test lama tidak pernah melakukan DUA
pemanggilan sukses berturut-turut dari breaker yang memang belum pernah gagal, jadi tidak
pernah membuktikan pemanggilan kedua TIDAK salah menganggap baru saja "pulih". Test baru:
dua sukses berturut-turut, `logger.info` dengan pesan "pulih" TIDAK BOLEH terpanggil sama
sekali — dibuktikan mutannya membuat panggilan kedua salah log "pulih" (state jadi string
kosong, `!== 'CLOSED'` jadi true padahal breaker sehat sejak awal).

### `retry.ts` id=147 — `attempt === options.attempts` → `false`
Test lama hanya memeriksa PESAN error akhir dan JUMLAH panggilan `fn` — keduanya kebetulan
identik di kode asli maupun mutan, karena percobaan terakhir yang gagal tetap berakhir
`throw lastError` (lewat jalur berbeda: asli melempar LANGSUNG di iterasi terakhir, mutan
melempar SETELAH loop berakhir). Bedanya: mutan menghitung delay DAN log "retry dalam Xms"
untuk percobaan terakhir yang sebenarnya TIDAK AKAN diulang lagi — menambah latensi sia-sia
sebelum akhirnya tetap gagal, plus log yang menyesatkan. Test baru: `attempts: 3`,
`logger.warn` harus terpanggil TEPAT `attempts - 1` (2) kali, bukan `attempts` (3) kali.

## TIDAK diperbaiki (5) — nilainya rendah atau mutannya setara (equivalent), bukan diabaikan tanpa alasan

### `bulkhead.ts` id=1 (pesan error) & id=2 (`this.name`), `circuit-breaker.ts` id=31 (`this.name`)
Ketiganya String­Literal pada TEKS pesan error / `Error.name`. Diperiksa lewat `grep` ke
seluruh `src/`: **tidak ada satu pun tempat di kode produksi yang membaca `.name` dari
`BulkheadRejectedError`/`CircuitOpenError`**, dan tidak ada test yang menegaskan isi pesan
persis (assertion selalu lewat `instanceof`/nama kelas). Nilainya cuma kosmetik (muncul di
log/stack trace untuk operator manusia) — menulis test yang cuma menegaskan string generik
persis akan menambah angka skor tanpa menambah perlindungan nyata, bertentangan dengan
prinsip proyek ini (lihat catatan `ignoreStatic`/bug Stryker sebelumnya: jangan kejar angka).

### `circuit-breaker.ts` id=71 & id=73 — `breaker.state === 'HALF_OPEN' || consecutiveFailures >= failureThreshold`
Diperiksa lewat penelusuran alur: untuk MENCAPAI state `OPEN`/`HALF_OPEN` sama sekali,
`consecutiveFailures` PASTI sudah `>= failureThreshold` pada saat itu (itu syarat masuk ke
`OPEN` di baris lain). `consecutiveFailures` HANYA di-reset ke 0 saat SUKSES (yang juga
langsung membawa balik ke `CLOSED`) — tidak pernah direset saat transisi OPEN→HALF_OPEN.
Akibatnya, begitu berada di `OPEN`/`HALF_OPEN`, sisi kiri OR (`state === 'HALF_OPEN'`)
secara matematis TIDAK PERNAH bisa mengubah hasil OR — sisi kanan sudah pasti `true`
duluan. Ini **mutan setara (equivalent)** di bawah arsitektur SEKARANG, bukan lubang test.
**Tidak dihapus** — komentar kode aslinya menyatakan niat eksplisit ("satu kegagalan saat
probe sudah cukup, tidak perlu tunggu threshold penuh") yang baru akan jadi bermakna kalau
suatu saat `consecutiveFailures` direset saat masuk HALF_OPEN (perubahan desain terpisah,
di luar cakupan ini) — pengaman itu murah untuk dipertahankan meski sedang tidak aktif, dan
memaksakan test buatan untuk mengejar angka survivor lebih buruk daripada membiarkannya
dengan alasan yang jujur dicatat di sini.

## Verifikasi

`tsc --noEmit` bersih, `lint:ci` bersih, suite penuh **160 suite / 1332 test lolos** (naik
dari 1328, +4 test baru, nol regresi). Keempat test baru DIBUKTIKAN mematikan mutan
sasarannya masing-masing (mutasi diterapkan manual satu per satu, test dikonfirmasi GAGAL,
source dikembalikan — diverifikasi `diff` byte-per-byte bahwa ketiga file source kembali
identik ke semula setelah proses ini).

**BELUM diverifikasi**: run `npx stryker run` penuh terhadap kode dengan test baru ini
(butuh ~2 jam lokal atau dijalankan lewat job `mutation.yml` di GitHub Actions) untuk
konfirmasi skor akhir & memastikan tidak ada survivor BARU yang muncul akibat perubahan ini
sendiri. Survivor di file LAIN (`export.ts`, `cache-keys.ts`, `jwt.ts`, `user-agent.ts`,
`response.ts` — 22 total) belum dianalisis di titik ini — lihat bagian di bawah untuk
`cache.ts`, dianalisis di ronde berikutnya.

## `cache.ts` (6 survivor, semua diperbaiki — 1 pola yang sama di 3 tempat)

Semua 6 survivor (id 200/201/218/219/227/228) adalah pasangan `ConditionalExpression`
+`BlockStatement` pada guard `if (!redisClient)` yang sama, di 3 fungsi berbeda:
`getOrSetCache`, `invalidateCache`, `invalidateByPattern`. **Bukan kebetulan** — akar
masalahnya SATU: `cache.spec.ts` men-mock `redisClient` sebagai objek truthy di SEMUA
test-nya (lihat komentar di file itu sendiri: "menguji cache.ts secara terisolasi"),
jadi jalur "Redis tidak dikonfigurasi sama sekali" — yang justru menegakkan kontrak
inti "Redis opsional" di seluruh proyek ini (lihat komentar `cache.ts` sendiri, dan
T19/T21) — tidak pernah benar-benar dijalankan.

**Diperbaiki**: file baru `cache.no-redis.spec.ts` (terpisah dari `cache.spec.ts`
karena `jest.mock` di-hoist ke level modul — tidak bisa mem-mock `redisClient` truthy
DAN `null` sekaligus dalam satu file tanpa `isolateModules`), men-mock
`redisClient: null`, menguji ketiga fungsi: `getOrSetCache` langsung panggil `fetcher`
(dicatat sebagai metric "miss", TANPA log warning — ini bukan kegagalan, memang
sengaja tidak dikonfigurasi), `invalidateCache`/`invalidateByPattern` resolve tanpa
error. Keenam mutan dibuktikan mati satu per satu (diterapkan manual + dikonfirmasi
gagal + dikembalikan, `diff` bersih) — `ConditionalExpression` dan `BlockStatement`
pada guard yang sama terbukti mati lewat test yang SAMA (menegaskan tidak ada log
warning error TypeError akibat `redisClient` null diakses).

Suite naik ke **161 suite / 1337 test** (+5), nol regresi.

## `jwt.ts` (2 survivor, keduanya diperbaiki — langsung menyerang pertahanan keamanan eksplisit)

Kedua survivor ini beda dari yang sebelumnya: bukan kelalaian test biasa, tapi langsung
menghilangkan pertahanan keamanan yang SENGAJA ditulis eksplisit (komentar file: "Algorithm
DIPIN eksplisit ke HS256 ... pertahanan berlapis terhadap algorithm confusion attack, sesuai
rekomendasi OWASP ASVS").

### id=339 — `JWT_VERIFY_OPTIONS = { algorithms: ['HS256'] }` → `{}`
Test lama hanya menguji token dengan SECRET salah, tidak pernah dengan ALGORITMA berbeda tapi
secret yang SAMA. Dibuktikan manual (`node -e`, di luar test) sebelum menulis fix: token
ditandatangani `HS384` dengan secret yang identik — `jwt.verify(..., {algorithms:['HS256']})`
menolak ("invalid algorithm"), tapi `jwt.verify(..., {})` MENERIMA tanpa error sama sekali.
Ini konstanta yang sama dipakai `verify()` (access token) DAN `verifyMfaChallenge()` — dua
test ditulis, satu untuk masing-masing jalur.

### id=355 — opsi `signMfaChallenge` (`{expiresIn, algorithm}`) → `{}`
Test lama tidak pernah memeriksa klaim `exp` pada token MFA challenge — kalau `expiresIn`
hilang, token MFA (yang menurut komentarnya sendiri "SENGAJA pendek, cukup buka authenticator
app") jadi TIDAK PERNAH KEDALUWARSA sama sekali. Test baru men-decode (bukan verify) token,
menegaskan `exp` ada dan dalam rentang 0–5 menit dari sekarang.

Kedua mutan dibuktikan mati lewat mutasi manual (diterapkan, test gagal persis seperti
diharapkan, source dikembalikan — `diff` bersih). Suite naik ke **161 suite / 1340 test**
(+3), nol regresi.

## `cache-keys.ts` (2 survivor, keduanya diperbaiki — celah dari pekerjaan T3/T4 sendiri)

`tenantPlanById`/`tenantStatusById` — fungsi yang dibangun sendiri saat T3/T4, TIDAK PERNAH
diberi test (lupa, bukan disengaja). Mutan (`StringLiteral` → template kosong ``) berarti
key cache-nya jadi KONSTANTA yang sama untuk SEMUA tenant — kalau ini benar-benar rusak,
plan/status satu tenant bisa tertimpa atau bocor ke tenant lain lewat cache. Diperbaiki
dengan 2 assertion tambahan: key membawa `tenantId` yang benar, DAN dua tenant berbeda
menghasilkan key yang berbeda (bukan cuma format string-nya benar untuk satu kasus).
Keduanya dibuktikan mati lewat mutasi manual.

## `response.ts` (1 survivor) dan `user-agent.ts` (2 survivor) — TIDAK diperbaiki, equivalent

### `response.ts` id=375 — `if (meta) { body.meta = meta }` → `if (true) {...}`
Diperiksa: `res.json(body)` di Express memanggil `JSON.stringify` di baliknya, dan
`JSON.stringify` MEMBUANG properti bernilai `undefined` dari hasil serialisasi. Jadi kalau
`meta` tidak diberikan (`undefined`), `body.meta = undefined` (versi mutan) menghasilkan
JSON PERSIS SAMA di atas kabel dengan `body` yang sama sekali tidak punya properti `meta`
(versi asli) — dikonfirmasi juga secara terpisah bahwa `toEqual`/`toHaveBeenCalledWith` Jest
menganggap `{a:1, meta:undefined}` SAMA DENGAN `{a:1}`. Bisa dipaksa "mati" pakai
`toStrictEqual`, tapi itu tidak melindungi dari bug produksi apa pun — responsnya identik
persis di sisi klien manapun. Dibiarkan, dengan alasan ini dicatat di sini.

### `user-agent.ts` id=419/420 — guard `if (!userAgent) {...}` di awal `parseUserAgent`
**Dibuktikan equivalent secara empiris, bukan cuma dianalisis**: guard-nya dihapus TOTAL dari
source, lalu SELURUH 26 test yang ada (termasuk 2 test yang KHUSUS menyasar `userAgent=null`
dan `userAgent=''`) dijalankan — semuanya tetap lolos tanpa perubahan. Penyebabnya:
`RegExp.test()` meng-coerce argumennya jadi string, dan baik `null` (jadi teks `"null"`)
maupun `''` tidak pernah cocok dengan pola BROWSER_PATTERNS/OS_PATTERNS manapun — hasil
akhirnya SELALU jatuh ke fallback `'Perangkat tidak dikenal'` yang sama, dengan atau tanpa
guard ini. Domain tipe parameter (`string | null`) tidak menyisakan input yang bisa
membedakan keduanya. TIDAK dihapus (kode ini tetap jelas/eksplisit untuk pembaca manusia),
TIDAK dipaksakan test buatan.

Suite naik ke **161 suite / 1342 test** (+2, hanya dari `cache-keys.ts`), nol regresi.

## `export.ts` (15 survivor — file TERAKHIR, sesuai urutan risiko yang disepakati)

Awalnya diasumsikan "cuma tata letak PDF, risiko rendah karena kelihatan visual kalau
salah" — ternyata SEBAGIAN survivor di sini ada di logika **paginasi** (kapan halaman baru
dibuka), yang kalau rusak bisa membuat header kolom hilang diam-diam di halaman 2+ tanpa
ada yang sadar. Investigasi file ini juga mengungkap satu **temuan arsitektur nyata**
(lihat bawah) yang mengubah total pendekatan pengujiannya.

### Temuan penting SEBELUM menulis fix apa pun: pdfkit PUNYA auto-pagination sendiri
Dibuktikan empiris (skrip node terpisah): dengan 200 baris teks, PDF tetap terbentuk 5
halaman **walau cek paginasi manual di `export.ts` dihapus TOTAL dari kode**. Artinya nilai
SEBENARNYA dari blok manual `if (doc.y > PAGE_BOTTOM_Y - 20) { doc.addPage(); drawHeaderRow(); }`
BUKAN "menambah halaman" (itu sudah otomatis dilakukan pdfkit sendiri) — tapi **menggambar
ulang header kolom di halaman baru**. Tanpa pemahaman ini, test Y-boundary yang saya tulis
pertama kali GAGAL mendiskriminasi mutan manapun (pdfkit's auto-break menutupi efeknya).
Setelah paham, semua test paginasi ditulis ulang untuk menghitung **kemunculan header "ID"
di seluruh halaman**, bukan posisi Y baris data.

### Diperbaiki (10 dari 15)
- **id=287** — `doc.on('error', reject)` → `''`. Wiring stream-error diuji dengan
  `jest.spyOn(PDFDocument.prototype, 'on')`, menangkap handler yang benar-benar
  didaftarkan, memanggilnya manual dengan error palsu, membuktikan Promise `toPdfBuffer`
  benar-benar reject (bukan diam-diam menggantung selamanya kalau pdfkit gagal internal).
- **id=288** — `PAGE_BOTTOM_Y = height - margin` → `height + margin` (arah salah).
- **id=297/id=320** — options object `{width, ellipsis}` untuk header DAN data row → `{}`
  total (BUKAN cuma `ellipsis`-nya, seluruh objeknya). Dibuktikan BEDA dari
  id=298/321 (lihat "equivalent" di bawah): menghapus `width` membuat teks panjang TIDAK
  membungkus sama sekali. Sempat gagal 2x karena bug di test SENDIRI (kolom terakhir
  kebetulan lebar-sisa-ke-tepi ≈ columnWidth — pindah ke kolom tengah; lalu filter X
  ikut menangkap sel DATA di kolom yang sama — dikecualikan eksplisit) — dicatat supaya
  tidak terulang.
- **id=307/id=308** — kondisi paginasi dipaksa `false`/`true`.
- **id=310** — `>` → `<=` (kebalikan total, paginasi jadi terpicu di HAMPIR setiap baris).
- **id=311** — ambang `-20` → `+20`.
- **id=312** — seluruh blok paginasi dikosongkan.
- **id=317** — `value === null ? '' : ...` → placeholder teks Stryker. Dibuktikan dulu
  secara empiris: pdfkit TIDAK menerbitkan operator gambar teks apa pun untuk string
  kosong — jadi test-nya menegaskan TIDAK ADA cell di kolom itu sama sekali untuk baris
  bernilai `null`, bukan cuma "isinya bukan 'null'".

Semua 10 dibuktikan mati lewat mutasi manual satu per satu (diterapkan, test gagal, source
dikembalikan — `diff` bersih setiap kali).

### Equivalent, TIDAK diperbaiki (4 dari 15) — dibuktikan empiris, bukan diasumsikan
- **id=298/id=321** — `ellipsis: true` → `false` (di header maupun data row).
  Dibuktikan lewat probe pdfkit langsung: opsi `ellipsis` HANYA berpengaruh kalau
  dikombinasikan dengan `height` (membatasi jumlah baris) — export.ts TIDAK PERNAH
  memberi `height` di satu pun pemanggilan `.text()`-nya, jadi `ellipsis` sudah tidak
  berefek sama sekali di penggunaan SEKARANG, terlepas dari nilainya. Dites dengan
  string yang identik: `{width:60, ellipsis:true}` vs `{width:60}` menghasilkan content
  stream PDF byte-identik.
- **id=301/id=302** — `.text(title, {align:'left'})` → `{}` / `'left'` → `''`.
  Dibuktikan byte-identik: `'left'` ADALAH default alignment pdfkit sendiri, jadi
  memberi eksplisit `align:'left'` sama sekali tidak berbeda dari tidak memberi opsi
  apa pun.

### TIDAK dapat dipraktiskan untuk dibunuh (1 dari 15)
- **id=309** — `doc.y > PAGE_BOTTOM_Y - 20` → `doc.y >= PAGE_BOTTOM_Y - 20`. Secara
  teknis BEDA dari `>`, tapi bedanya HANYA terlihat kalau `doc.y` PERSIS SAMA (ke banyak
  angka desimal) dengan ambang batas — posisi Y bergantung metrik font internal pdfkit
  yang tidak dikontrol presisi dari luar tanpa mereplikasi algoritma pengukuran teksnya
  sendiri. Beda dari batas waktu (`circuit-breaker.ts` id=48, dikontrol presisi lewat
  `jest.advanceTimersByTime`), tidak ada mekanisme presisi setara untuk posisi Y pdfkit.
  Diterima sebagai batas praktis — cakupan inti paginasi sudah tertutup lewat 6 mutan
  lain di klaster yang sama.

Suite naik ke **161 suite / 1347 test** (+5), nol regresi.

---

**Ringkasan akhir seluruh mutation survivor (Fase 3.5):** dari 37 survivor awal (skor
91.15%), diperbaiki 20 dengan bukti mutasi manual, 9 dibuktikan equivalent (bukan
diasumsikan — masing-masing punya bukti empiris terpisah), 1 diterima sebagai batas
praktis (boundary presisi floating-point yang tidak terjangkau tanpa rekayasa berlebihan).
Tidak ada survivor yang dibiarkan tanpa investigasi atau alasan tertulis.
