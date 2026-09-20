# SBOM & Image Signing (Kelompok 2, item 2.5)

## Desain

**SBOM (Software Bill of Materials)** — `syft` men-generate daftar
LENGKAP semua dependency yang benar-benar ada di dalam image Docker
(bukan cuma `package.json`, tapi juga dependency sistem Alpine),
format CycloneDX 1.7. Diupload sebagai artifact CI (retensi 90 hari)
supaya bisa diaudit kapan saja — "versi mana yang punya dependency X
versi berapa" tanpa perlu rebuild image lama.

**Image signing (cosign, KEYLESS)** — setiap image yang lolos Trivy
scan ditandatangani pakai identitas OIDC workflow GitHub Actions itu
sendiri (Sigstore Fulcio + transparency log Rekor publik) — **BUKAN**
private key yang disimpan sebagai GitHub Secret. Alasan keyless:
- Tidak ada key untuk bocor/dicuri/lupa di-rotate.
- Siapa pun bisa memverifikasi signature-nya benar berasal dari
  workflow CI repo ini (bukan dari mana pun), lewat transparency log
  publik Rekor — bukan cuma "percaya" ada file `.sig`.
- Ini pendekatan yang direkomendasikan resmi proyek Sigstore untuk
  CI/CD, dipakai luas (mis. semua image resmi Kubernetes sejak 1.24+).

**SBOM attestation** — SBOM yang sama JUGA di-attach ke image lewat
`cosign attest` (predicate type `cyclonedx`) — jadi SBOM-nya sendiri
juga ikut tertandatangani & terikat ke digest image spesifik, bukan
cuma file lepas yang bisa ditukar diam-diam.

## Kenapa image perlu di-push ke registry dulu (perubahan dari sebelumnya)

Sebelumnya job `docker-build-and-scan` cuma `docker build` lokal di
runner (image tidak pernah ke mana-mana). Signing container image
(beda dari sign-blob) bekerja terhadap REFERENSI image di registry
(by digest) — jadi CI sekarang **push ke GHCR**
(`ghcr.io/<owner>/<repo>`) sebelum scan+sign+attest. Trivy scan-nya
sendiri juga dipindah supaya scan digest yang SAMA persis dengan yang
di-sign (bukan tag lokal terpisah) — memastikan yang di-scan dan yang
di-sign adalah image yang IDENTIK bit-per-bit.

### Push hanya pada event `push` ke `main` (temuan T9)

Alur di atas (push ke GHCR, scan by digest, SBOM, sign, attest) sebelumnya berjalan di SETIAP run CI,
termasuk yang dipicu `pull_request`. Akibatnya image dari kode yang belum di-review ikut masuk registry
dan ditandatangani (tanda tangan hanya berarti "dibangun oleh workflow ini di SHA itu", bukan "sudah
di-review"), dan PR dari fork gagal karena tidak punya `packages: write`. Sekarang ada dua mode
(dibedakan `github.event_name`):

| Langkah | `push` ke `main` | `pull_request` |
|---|---|---|
| Login GHCR, push image | ya (alur lama) | tidak |
| Build | `push: true` | `load: true` (image lokal di runner) |
| Trivy scan | by digest dari registry | image lokal, by tag SHA |
| SBOM (syft) + unggah artifact | by digest dari registry | dari image lokal (`docker:`) |
| Sign + attest (cosign) | ya | tidak |

Gate Trivy dan pembuatan SBOM tetap berlaku di PR. Langkah "Tentukan referensi image" gagal keras kalau digest
kosong pada event `push`. Batas yang jujur: izin `packages: write`/`id-token: write` tetap di level job
(GitHub tidak mendukung izin per-kondisi); yang berubah adalah langkah yang memakainya tidak dijalankan di PR.
Diverifikasi dengan `actionlint` dan uji shell langkah referensi; belum dibuktikan di run GitHub Actions
sungguhan (lihat catatan verifikasi di bawah).

### Kebijakan pin action pihak ketiga (temuan T10)

Step Trivy memakai `aquasecurity/trivy-action` yang di-pin ke **SHA commit penuh** (`# v0.36.0`),
bukan `@master` atau tag. Alasannya insiden 2026-03-19: 76 dari 77 tag `trivy-action` di-force-push ke
malware pencuri kredensial (GHSA-69fq-xp46-6x23 / CVE-2026-33634); tag bisa dipindahkan, SHA tidak.
Job ini berjalan dengan `packages: write` dan `id-token: write`, jadi action yang jahat akan mendapat
token bertenaga. Diperiksa sebelum pin: SHA `ed142fd0…` adalah commit tag v0.36.0; `setup-trivy` di
dalamnya di-pin SHA `3fb12ec1…` (sama dengan tag `v0.2.6` saat ini, versi yang dibuat ulang dengan isi
aman); tidak ada pola mencurigakan di `action.yaml`/`entrypoint.sh`.

**Batas yang jujur:** action lain di workflow (`anchore/sbom-action`, `sigstore/cosign-installer`,
`docker/*`, `actions/*`) masih memakai tag mayor yang bisa berubah — lihat temuan T12 di roadmap. Versi
Trivy yang dipakai berubah dari "apa pun yang ada di master" menjadi v0.70.0; hasil scan bisa sedikit
berbeda dan gate perlu dibuktikan lewat run CI sungguhan.

## Verifikasi nyata yang sudah dijalankan (sandbox)

`syft` dan `cosign` diinstall sungguhan dan diuji langsung (bukan cuma
dibaca dokumentasinya):

1. **SBOM asli** dari source code project ini — `syft dir:.` berhasil
   mendeteksi **743 komponen** npm sungguhan (termasuk `openid-client`,
   `express`, `zod`, dst), format CycloneDX 1.7 valid (924 KB).
2. **Sign + verify sungguhan** — SBOM di atas ditandatangani pakai
   keypair cosign asli (`cosign sign-blob`), lalu diverifikasi
   (`cosign verify-blob`) → **"Verified OK"**.
3. **Uji negatif (tamper)** — SBOM yang isinya diubah 1 karakter
   diverifikasi terhadap signature ASLI → **ditolak**
   (`invalid signature when validating ASN.1 encoded signature`),
   membuktikan verifikasi benar-benar memeriksa isi, bukan cuma
   memeriksa file signature-nya ada.

## Yang BELUM bisa diverifikasi di sandbox (butuh GitHub Actions sungguhan)

- **Push image ke GHCR** — sandbox ini tidak punya akses Docker
  Hub/registry mana pun (`docker build` sendiri pun tidak bisa
  dijalankan di sini, base image `node:20-alpine` tidak bisa
  di-pull).
- **Keyless signing lewat OIDC** — mekanismenya BEDA dari key-based
  yang saya uji di atas (butuh token identitas dari runner GitHub
  Actions sungguhan yang terhubung ke Fulcio/Rekor asli) — tidak bisa
  disimulasikan di luar GitHub Actions.
- **`cosign attest`** — sama alasannya, butuh image sungguhan di
  registry sungguhan.

Ini SEMUA butuh dikonfirmasi lewat run CI sungguhan di GitHub Actions
— lihat instruksi verifikasi di pesan pemasangan.

## Cara verifikasi manual (setelah CI jalan)

```bash
# Lihat signature-nya (tersimpan di GHCR sebagai OCI artifact terpisah)
cosign verify ghcr.io/<owner>/<repo>:<sha> \
  --certificate-identity-regexp="https://github.com/<owner>/<repo>/.github/workflows/ci.yml@.*" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com

# Lihat SBOM yang ter-attest
cosign download attestation ghcr.io/<owner>/<repo>:<sha> | jq -r '.payload' | base64 -d | jq .predicate
```

## Yang belum tercakup (scope sadar)

- Belum ada enforcement "tolak deploy kalau image tidak tertandatangani"
  (mis. lewat admission controller Kubernetes/`cosign verify` sebagai
  gate terpisah sebelum `kubectl apply`) — saat ini signing bersifat
  informational/audit-trail, belum jadi hard gate di alur deploy.
- SBOM cuma di-generate untuk image `backend_app` — belum ada untuk
  image `worker_app` terpisah (kalau nanti dipisah jadi image
  berbeda).
