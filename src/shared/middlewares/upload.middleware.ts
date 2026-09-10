import multer from 'multer';
import { BadRequestError } from '../utils/http-error';

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Tipe file yang diizinkan — gambar umum + PDF, sesuai batasan yang
 * diminta (#5). Dicek lewat `mimetype` yang dikirim client; ini bukan
 * jaminan kriptografis (mimetype bisa dipalsukan), tapi cukup untuk
 * menyaring kesalahan/upload iseng di titik masuk paling awal.
 * Validasi konten sebenarnya (magic bytes) bisa ditambahkan di
 * `UploadService` jika threat model aplikasi butuh jaminan lebih kuat.
 */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

/**
 * `memoryStorage()` — file TIDAK PERNAH ditulis ke disk lokal server,
 * hanya dipegang sebagai `Buffer` di memori (`req.file.buffer`) lalu
 * langsung di-stream ke S3 oleh `UploadService`. Cocok untuk file
 * kecil (dibatasi 5MB di bawah); untuk file jauh lebih besar,
 * pertimbangkan `multer-s3` (upload streaming langsung tanpa buffer
 * penuh di memori) sebagai optimasi lanjutan.
 */
const storage = multer.memoryStorage();

export const upload = multer({
  storage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(new BadRequestError(`Tipe file ${file.mimetype} tidak diizinkan. Hanya image/pdf.`));
      return;
    }
    callback(null, true);
  },
});
