import { redisClient } from '../config/redis';
import { logger } from '../logger';

const MAX_FAILED_ATTEMPTS = 5;
// Jendela waktu percobaan — 5 kegagalan HARUS terjadi dalam rentang
// ini untuk memicu lock; percobaan gagal yang tersebar sangat lambat
// (mis. satu kegagalan per jam) tidak dianggap brute-force.
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const LOCK_DURATION_SECONDS = 15 * 60;

interface MemoryAttemptRecord {
  count: number;
  windowExpiresAt: number;
}

/**
 * Fallback in-memory — dipakai HANYA kalau `REDIS_URL` tidak
 * dikonfigurasi. Beda dari `cache.ts` (yang fallback ke "tidak ada
 * cache sama sekali" kalau Redis gagal), brute-force protection tetap
 * lebih baik ada dalam bentuk in-memory per-proses daripada tidak ada
 * sama sekali — meski tidak akan konsisten lintas banyak instance
 * server (tiap instance punya hitungannya sendiri), untuk deployment
 * single-instance/development ini tetap memberi perlindungan nyata.
 */
const memoryAttempts = new Map<string, MemoryAttemptRecord>();
const memoryLocks = new Map<string, number>(); // identifier -> lockedUntil (epoch ms)

/**
 * Finding #21 (P1 Security Hardening, MFA) — parameter di seluruh
 * modul ini di-generalisasi dari `email` menjadi `identifier`
 * (murni penamaan, TIDAK ada perubahan perilaku): sebelumnya modul
 * ini HANYA dipakai `AuthService.login` (identifier = email user).
 * Sekarang `AuthService.verifyMfaLogin` juga memakainya untuk
 * membatasi percobaan kode TOTP/recovery code yang salah, dengan
 * identifier `mfa:<userId>` (lihat komentar lengkap di
 * `AuthService.verifyMfaLogin`) — namespace terpisah dari lock
 * password login supaya keduanya tidak saling mengunci satu sama
 * lain (gagal MFA berkali-kali tidak boleh ikut mengunci login
 * password akun yang sama, begitu pula sebaliknya).
 */
function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function attemptsKey(identifier: string): string {
  return `login_attempts:${identifier}`;
}

function lockKey(identifier: string): string {
  return `login_lock:${identifier}`;
}

export interface LockStatus {
  locked: boolean;
  /** Sisa waktu kunci dalam detik — hanya terisi ketika `locked === true`. */
  remainingSeconds?: number;
}

/**
 * Mengecek apakah suatu identifier (email untuk login password, atau
 * `mfa:<userId>` untuk verifikasi TOTP/recovery code — Finding #21)
 * SEDANG dikunci akibat terlalu banyak percobaan gagal — dipanggil di
 * AWAL `AuthService.login`/`AuthService.verifyMfaLogin`, SEBELUM
 * verifikasi kredensial/kode apa pun dilakukan. Ini SENGAJA dilakukan
 * lebih dulu (bukan setelah kredensial terbukti salah lagi) supaya
 * identifier yang sedang terkunci tidak membuka celah *timing attack*
 * tambahan lewat perbandingan durasi bcrypt/TOTP.
 */
export async function checkAccountLock(identifierInput: string): Promise<LockStatus> {
  const identifier = normalizeIdentifier(identifierInput);

  if (redisClient) {
    try {
      const ttl = await redisClient.ttl(lockKey(identifier));
      return ttl > 0 ? { locked: true, remainingSeconds: ttl } : { locked: false };
    } catch (error) {
      logger.warn(
        { err: error, identifier },
        'LoginAttemptTracker: gagal membaca status lock dari Redis — fail-open (tidak memblokir login)'
      );
      return { locked: false };
    }
  }

  const lockedUntil = memoryLocks.get(identifier);
  if (lockedUntil && lockedUntil > Date.now()) {
    return { locked: true, remainingSeconds: Math.ceil((lockedUntil - Date.now()) / 1000) };
  }
  if (lockedUntil) {
    memoryLocks.delete(identifier);
  }
  return { locked: false };
}

/**
 * Mencatat satu percobaan GAGAL untuk suatu identifier — dipanggil
 * setiap kali email tidak ditemukan/password salah (login), ATAU kode
 * TOTP/recovery code salah (`mfa:<userId>` — Finding #21). Begitu
 * jumlah kegagalan dalam jendela waktu mencapai `MAX_FAILED_ATTEMPTS`,
 * identifier itu dikunci selama `LOCK_DURATION_SECONDS`.
 */
export async function recordFailedAttempt(identifierInput: string): Promise<void> {
  const identifier = normalizeIdentifier(identifierInput);

  if (redisClient) {
    try {
      const key = attemptsKey(identifier);
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, ATTEMPT_WINDOW_SECONDS);
      }
      if (count >= MAX_FAILED_ATTEMPTS) {
        await redisClient.set(lockKey(identifier), '1', 'EX', LOCK_DURATION_SECONDS);
        logger.warn(
          { identifier, attempts: count },
          'LoginAttemptTracker: akun dikunci sementara akibat terlalu banyak percobaan login gagal'
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, identifier },
        'LoginAttemptTracker: gagal mencatat percobaan gagal ke Redis'
      );
    }
    return;
  }

  const now = Date.now();
  const existing = memoryAttempts.get(identifier);
  const record: MemoryAttemptRecord =
    existing && existing.windowExpiresAt > now
      ? { count: existing.count + 1, windowExpiresAt: existing.windowExpiresAt }
      : { count: 1, windowExpiresAt: now + ATTEMPT_WINDOW_SECONDS * 1000 };
  memoryAttempts.set(identifier, record);

  if (record.count >= MAX_FAILED_ATTEMPTS) {
    memoryLocks.set(identifier, now + LOCK_DURATION_SECONDS * 1000);
    logger.warn(
      { identifier, attempts: record.count },
      'LoginAttemptTracker: akun dikunci sementara (in-memory) akibat terlalu banyak percobaan login gagal'
    );
  }
}

/**
 * Mereset hitungan percobaan gagal & lock untuk suatu identifier —
 * dipanggil setelah login/verifikasi MFA BERHASIL. Percobaan sah
 * berikutnya tidak boleh terwarisi hitungan kegagalan dari percobaan-
 * percobaan sebelumnya.
 */
export async function resetAttempts(identifierInput: string): Promise<void> {
  const identifier = normalizeIdentifier(identifierInput);

  if (redisClient) {
    try {
      await redisClient.del(attemptsKey(identifier), lockKey(identifier));
    } catch (error) {
      logger.warn(
        { err: error, identifier },
        'LoginAttemptTracker: gagal mereset percobaan di Redis'
      );
    }
    return;
  }

  memoryAttempts.delete(identifier);
  memoryLocks.delete(identifier);
}
