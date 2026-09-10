import crypto from 'node:crypto';
import { env } from '../config/env';

/**
 * Encryption Service (Phase 12 — Enterprise Security) — enkripsi
 * simetrik AES-256-GCM untuk data yang harus terenkripsi SAAT
 * DIAM di database ("column encryption"), terpisah dari hashing
 * satu-arah (bcrypt untuk password) — enkripsi di sini SENGAJA
 * dua-arah (`encrypt`/`decrypt`) karena aplikasi butuh nilai
 * ASLI-nya kembali (mis. `User.mfaSecret` harus dibaca ulang untuk
 * memverifikasi kode TOTP), bukan hanya membandingkan hash seperti
 * password.
 *
 * KENAPA AES-256-GCM (bukan mode lain seperti CBC) — GCM adalah
 * *authenticated encryption*: auth tag yang dihasilkan membuat
 * ciphertext yang diubah (bukan cuma dibaca) oleh pihak yang tidak
 * punya key akan GAGAL didekripsi dengan jelas (melempar error),
 * bukan menghasilkan plaintext yang rusak diam-diam seperti mode CBC
 * tanpa MAC terpisah.
 *
 * FORMAT OUTPUT: `<iv_base64>:<authTag_base64>:<ciphertext_base64>`
 * — IV & auth tag disimpan BERSAMA ciphertext (bukan rahasia,
 * berbeda dari key) karena keduanya WAJIB persis sama saat dekripsi;
 * menyimpannya terpisah hanya menambah kompleksitas tanpa menambah
 * keamanan.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12; // 96-bit — ukuran IV yang direkomendasikan NIST untuk GCM
const FIELD_SEPARATOR = ':';

/**
 * Kunci AKTIF (dipakai untuk SEMUA enkripsi baru) & kunci LAMA
 * (dicoba HANYA saat dekripsi gagal dengan kunci aktif) — pola
 * rotasi identik dengan `JWT_SECRET`/`JWT_SECRET_PREVIOUS` di
 * `env.ts`. Di-decode sekali di module scope (bukan setiap panggilan
 * `encrypt`/`decrypt`) karena `Buffer.from(base64)` tidak perlu
 * diulang untuk key yang sama sepanjang proses berjalan.
 */
const activeKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');
const previousKey = env.ENCRYPTION_KEY_PREVIOUS
  ? Buffer.from(env.ENCRYPTION_KEY_PREVIOUS, 'base64')
  : null;

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    FIELD_SEPARATOR
  );
}

function decryptWithKey(payload: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64] = payload.split(FIELD_SEPARATOR);
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error('Format ciphertext tidak valid (harus iv:authTag:ciphertext)');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(), // melempar error kalau auth tag tidak cocok — key salah ATAU ciphertext diubah
  ]);

  return plaintext.toString('utf8');
}

export const encryptionService = {
  /** Selalu memakai `activeKey` — tidak pernah menulis data baru dengan `previousKey`. */
  encrypt(plaintext: string): string {
    return encryptWithKey(plaintext, activeKey);
  },

  /**
   * Coba `activeKey` dulu; kalau gagal (auth tag tidak cocok —
   * sinyal paling umum untuk "key salah", BUKAN data korup, karena
   * GCM menolak dekripsi begitu auth tag tidak cocok) DAN
   * `previousKey` tersedia, coba `previousKey` — inilah mekanisme
   * yang membuat rotasi `ENCRYPTION_KEY` tidak membuat data lama
   * langsung tidak terbaca (lihat komentar `ENCRYPTION_KEY_PREVIOUS`
   * di `env.ts`).
   */
  decrypt(payload: string): string {
    try {
      return decryptWithKey(payload, activeKey);
    } catch (activeKeyError) {
      if (!previousKey) {
        throw activeKeyError;
      }
      return decryptWithKey(payload, previousKey);
    }
  },
};
