# Audit keamanan SSO (temuan T14, hasil T16)

Kode SSO (`sso.service.ts`, `sso.controller.ts`, `sso.repository.ts`) dibuat sesi AI paralel tanpa akses jaringan atau
Redis/IdP sungguhan, jadi belum pernah dijalankan. Dokumen ini mencatat hasil audit: apa yang sudah baik, apa yang
DIPERBAIKI, dan apa yang MASIH TERBUKA (perlu keputusan). Setiap klaim diberi jenis buktinya.

Jenis bukti: **[dijalankan]** dieksekusi dan hasilnya diamati; **[dibaca]** dari pembacaan kode, belum dijalankan;
**[dites-tiruan]** dites dengan tiruan yang meniru perilaku yang relevan.

## Yang sudah baik [dibaca]

- PKCE (`S256`), `state`, dan `nonce`; `nonce`, `state`, dan `code_verifier` divalidasi oleh `openid-client` di `callback`.
- `redirect_uri` dibentuk dari `APP_BASE_URL` (bukan dari request), sehingga tidak bisa dimanipulasi klien.
- `state` terikat ke tenant: `state` milik tenant A ditolak di callback tenant B.
- Identitas ditautkan lewat `(tenantId, sub)`, bukan email, untuk login berikutnya.
- Auto-link lintas-tenant ditolak (`Email ini sudah terdaftar di tenant lain`).
- `clientSecret` dienkripsi (`encryptionService`) dan tidak pernah dikembalikan API.
- Redis wajib (fail-closed), bukan fail-open: tanpa Redis SSO menolak, tidak berjalan tanpa proteksi state.
- Redirect ke frontend memakai `SSO_FRONTEND_CALLBACK_URL` tetap (env), bukan URL dari query; token tidak pernah ada di URL,
  hanya kode tukar sekali-pakai berumur 60 detik.
- Endpoint berada di bawah `authRateLimiter`.

## DIPERBAIKI: kode tukar dan `state` "sekali-pakai" ternyata tidak sekali-pakai (T16)

**Cacat [dijalankan].** `consume` dan `handleCallback` mengambil nilai dengan `redis.get(key)` lalu `redis.del(key)` sebagai dua
perintah terpisah. Permintaan yang bersamaan sama-sama lolos `GET` sebelum ada yang sempat `DEL`. Diukur dengan
`SsoService.consume` asli dan klien `ioredis` asli terhadap Redis 7.0 sungguhan: **2, 5, dan 20 panggilan bersamaan untuk
SATU kode tukar semuanya menerima token** (2/2, 5/5, 20/20).

**Dampak.** Kode tukar berada di URL redirect ke frontend (riwayat browser, log proxy, header Referer bila ada tautan keluar).
Penyerang yang melihat kodenya bisa berlomba dengan frontend yang sah dan sama-sama mendapat access+refresh token. Untuk
`state`, dampaknya diredam karena kode otorisasi IdP sendiri sekali-pakai, tetapi jaminannya tetap tidak berlaku.

**Perbaikan.** `takeOnce`: `MULTI` → `GET` → `DEL` → `EXEC`, atomik: hanya satu pemanggil yang menerima nilainya. Tidak butuh
`GETDEL` (Redis ≥ 6.2), dan berlaku juga untuk `Cluster` (satu kunci = satu slot).

**Bukti sesudah perbaikan [dijalankan].** Redis 7.0 sungguhan: 2, 5, 20, dan 50 panggilan bersamaan → **tepat 1** yang menerima
token dan sisanya ditolak; kunci terhapus. **[dites-tiruan]** `sso.service.spec.ts` memakai Redis tiruan yang menyisipkan
perintah seperti Redis sungguhan (model itu dicocokkan dengan hasil di atas); mengembalikan kode ke pola `get`+`del` membuat
9 tes gagal, termasuk tiga tes konkurensi.

## TERBUKA: butuh keputusan

### S1. Login CSRF: `state` tidak terikat ke browser yang memulai login [dibaca] — dinilai sedang

`state`, `nonce`, dan `code_verifier` disimpan hanya di Redis, tanpa pengikat ke browser pemulai (cookie). Penyerang dapat
memulai login SSO di browsernya, berhenti sebelum mengantar URL callback, lalu membuat korban membuka URL itu. Server
menemukan `state` di Redis, menukar kode dengan PKCE yang valid, dan menerbitkan kode tukar; frontend korban menukarnya dan
korban **masuk sebagai akun penyerang**. PKCE dan `state` di sini tidak menolong karena keduanya menjadi milik penyerang.
Belum direproduksi karena butuh IdP sungguhan.
**Mitigasi standar:** saat `/login`, set cookie `HttpOnly; SameSite=Lax; Path=/api/v1/auth/sso; Max-Age=300` berisi nilai acak,
simpan hash-nya di data `state` di Redis, lalu wajibkan cookie itu cocok di `/callback`. **Trade-off:** callback yang dibuka di
browser/perangkat lain (mis. pindah dari aplikasi mobile ke browser, webview tertanam) akan ditolak. Perlu keputusanmu.

### S2. SSRF lewat `issuerUrl` [dibaca] — dinilai rendah (hanya admin `sso.manage`)

`Issuer.discover(connection.issuerUrl)` melakukan permintaan dari server, dan `openid-client` lalu mengikuti `token_endpoint`,
`jwks_uri`, dst. dari dokumen metadata. `ssrf-guard.ts` sudah dipakai untuk webhook, tetapi TIDAK dipakai untuk SSO
(`sso.dto.ts` hanya `.url()`). Admin platform yang dikompromikan bisa mengarahkan server ke alamat internal. Mitigasi penuh
tidak cukup dengan memeriksa `issuerUrl`; semua endpoint hasil discovery harus divalidasi atau koneksi dibatasi ke IP publik,
dan dev lokal dengan IdP di `localhost` perlu pengecualian eksplisit.

### S3. Klaim `email_verified` tidak diperiksa; auto-link berdasarkan email [dibaca] — dinilai rendah sampai sedang

Login pertama menautkan identitas SSO ke akun lokal yang emailnya sama. Domain dicek (`@allowedEmailDomain`), tetapi
`email_verified` tidak. IdP yang membiarkan pengguna mengklaim email sembarang di domainnya (pola "nOAuth" pada Azure AD
multi-tenant) bisa dipakai untuk mengambil alih akun lokal yang sudah ada. Tergantung jenis IdP yang dipakai tiap tenant.
Mewajibkan `email_verified === true` bisa mematahkan IdP yang tidak mengirim klaim itu (Azure AD).

### S4. Email peka huruf besar/kecil di seluruh aplikasi [dibaca] — dinilai rendah

Tidak ada normalisasi email (`toLowerCase`) di pendaftaran, repository, maupun SSO. `Budi@acme.com` dari IdP tidak menemukan
akun `budi@acme.com`, sehingga akun ganda bisa terbentuk. Bukan spesifik SSO.

### S5. Catatan desain [dibaca]

- Login SSO tidak meminta MFA lokal (IdP bertanggung jawab atas faktor keduanya): keputusan wajar, tetapi perlu diketahui.
- `error_description` dari IdP diteruskan apa adanya ke pesan error (JSON, bukan HTML): risiko rendah.
- `emailVerifiedAt` diisi otomatis untuk user hasil provisioning tanpa memeriksa `email_verified` (lihat S3).

## Yang TIDAK diaudit

Alur end-to-end dengan IdP sungguhan (tidak ada IdP di sandbox), validasi tanda tangan `id_token` (didelegasikan ke
`openid-client`), dan `sso.repository.ts` selain dari pembacaan singkat.
