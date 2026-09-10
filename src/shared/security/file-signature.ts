/**
 * Validasi "magic bytes" (file signature) — Finding #18, P1 Security
 * Hardening (File Upload Security).
 *
 * SEBELUM ini, `upload.middleware.ts` (`fileFilter`) HANYA mengecek
 * `file.mimetype` yang dikirim CLIENT di multipart form-data — field
 * ini sepenuhnya dikontrol penyerang (bisa diisi apa saja, tidak ada
 * hubungan wajib dengan isi file sesungguhnya). Akibatnya penyerang
 * bisa upload file APA SAJA (mis. payload berbahaya, file executable)
 * selama field `Content-Type` di request-nya DIBOHONGI menjadi salah
 * satu dari 5 tipe yang diizinkan (`image/jpeg`, dst) — allowlist
 * MIME jadi tidak berarti apa-apa sebagai kontrol keamanan.
 *
 * Fungsi ini memeriksa BYTE PERTAMA file yang SUNGGUHAN diterima
 * (`file.buffer`, setelah multer selesai buffering — bukan lagi bisa
 * dipalsukan lewat header request) terhadap signature biner standar
 * tiap format. Dipanggil di `UploadService.uploadFile` SEBELUM file
 * diteruskan ke storage provider manapun.
 */

const SIGNATURES: Record<string, readonly (readonly number[])[]> = {
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  // GIF87a dan GIF89a — dua varian magic bytes yang valid.
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  ],
  // WEBP: "RIFF" di byte 0-3, lalu "WEBP" di byte 8-11 (byte 4-7
  // adalah panjang file, bervariasi — sengaja tidak ikut dicocokkan).
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // "%PDF"
};

function matchesSignature(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => buffer[index] === byte);
}

/**
 * `true` kalau byte pertama `buffer` cocok dengan signature biner
 * yang seharusnya dimiliki `mimetype`. Tipe di luar `SIGNATURES`
 * (seharusnya tidak pernah terjadi — `fileFilter` sudah membatasi ke
 * 5 tipe ini) dianggap TIDAK valid (fail-closed), bukan diloloskan.
 *
 * Khusus WEBP: pengecekan tambahan byte 8-11 ("WEBP") dilakukan di
 * sini (bukan di tabel `SIGNATURES`) karena panjangnya beda dari
 * signature "RIFF" di awal.
 */
export function matchesFileSignature(buffer: Buffer, mimetype: string): boolean {
  const candidates = SIGNATURES[mimetype];
  if (!candidates) {
    return false;
  }

  const matchesAny = candidates.some((sig) => matchesSignature(buffer, sig));
  if (!matchesAny) {
    return false;
  }

  if (mimetype === 'image/webp') {
    return buffer.length >= 12 && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }

  return true;
}
