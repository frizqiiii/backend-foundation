import { prisma } from '../../config/database';
import type { ScheduledJobDefinition, JobRunSummary } from '../scheduler.types';

/**
 * CATATAN ADAPTASI: brief asli meminta "cleanup temporary upload".
 * Modul upload di project ini (lihat `upload.middleware.ts`) memakai
 * `multer.memoryStorage()` — file diproses murni di memori lalu
 * langsung di-stream ke S3, TIDAK PERNAH ditulis ke disk lokal sama
 * sekali. Jadi tidak ada "file sementara" yang perlu dibersihkan;
 * membuat job untuk itu hanya akan jadi kode mati yang tidak pernah
 * menemukan apa pun untuk dihapus.
 *
 * Sebagai gantinya, slot job ini dipakai untuk kebutuhan cleanup yang
 * SUNGGUHAN ada di schema: `EmailVerificationToken` &
 * `PasswordResetToken` yang sudah lewat `expiresAt` tapi tidak pernah
 * dipakai user (link diabaikan/tidak pernah diklik) — keduanya
 * single-use dan dihapus otomatis SAAT dipakai (lihat
 * `AuthService.verifyEmail`/`resetPassword`), tapi yang TIDAK PERNAH
 * dipakai akan menumpuk selamanya tanpa job ini.
 *
 * Jadwal: setiap hari jam 02:30.
 */
async function cleanupExpiredAuthTokens(): Promise<JobRunSummary> {
  const now = new Date();

  const [expiredVerificationTokens, expiredResetTokens] = await Promise.all([
    prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: now } } }),
  ]);

  const totalDeleted = expiredVerificationTokens.count + expiredResetTokens.count;

  return {
    message: `${totalDeleted} token auth kedaluwarsa dihapus (${expiredVerificationTokens.count} verifikasi email, ${expiredResetTokens.count} reset password)`,
    details: {
      emailVerificationTokensDeleted: expiredVerificationTokens.count,
      passwordResetTokensDeleted: expiredResetTokens.count,
    },
  };
}

export const cleanupExpiredAuthTokensJob: ScheduledJobDefinition = {
  name: 'cleanup-expired-auth-tokens',
  cronExpression: '30 2 * * *',
  run: cleanupExpiredAuthTokens,
};
