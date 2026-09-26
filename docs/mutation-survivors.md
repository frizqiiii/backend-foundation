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
