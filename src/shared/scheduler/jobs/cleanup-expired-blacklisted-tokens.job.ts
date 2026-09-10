import { prisma } from '../../config/database';
import type { ScheduledJobDefinition, JobRunSummary } from '../scheduler.types';

/**
 * Menghapus baris `BlacklistedToken` yang `expiresAt`-nya sudah lewat.
 *
 * Ini SECARA LANGSUNG menutup gap yang sudah didokumentasikan sendiri
 * di `prisma/schema.prisma` pada model `BlacklistedToken`: "begitu
 * lewat, baris ini aman dibersihkan (belum ada job pembersihan
 * otomatis; tabel akan terus bertambah tanpa itu, layak jadi item
 * lanjutan)". Access token JWT yang sudah lewat `exp`-nya sendiri
 * sudah otomatis ditolak oleh `jwt.verify` di `auth.middleware.ts` —
 * baris blacklist untuknya jadi berlebihan begitu `expiresAt` lewat.
 *
 * Jadwal: setiap hari jam 02:15 — diberi jeda 15 menit dari job
 * refresh-token cleanup supaya keduanya tidak bersaing lock di tabel
 * berbeda pada detik yang sama persis.
 */
async function cleanupExpiredBlacklistedTokens(): Promise<JobRunSummary> {
  const result = await prisma.blacklistedToken.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });

  return {
    message: `${result.count} blacklisted token kedaluwarsa dihapus`,
    details: { deletedCount: result.count },
  };
}

export const cleanupExpiredBlacklistedTokensJob: ScheduledJobDefinition = {
  name: 'cleanup-expired-blacklisted-tokens',
  cronExpression: '15 2 * * *',
  run: cleanupExpiredBlacklistedTokens,
};
