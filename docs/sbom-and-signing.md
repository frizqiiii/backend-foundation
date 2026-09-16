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
