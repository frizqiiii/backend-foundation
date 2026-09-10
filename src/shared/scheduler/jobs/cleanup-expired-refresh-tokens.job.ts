import { prisma } from '../../config/database';
import type { ScheduledJobDefinition, JobRunSummary } from '../scheduler.types';

/**
 * Menghapus baris `RefreshToken` yang sudah tidak mungkin dipakai lagi
 * — baik karena `expiresAt` per-baris (rolling, direset tiap rotasi)
 * sudah lewat, MAUPUN karena `familySessionExpiresAt` (Finding #20,
 * batas ABSOLUT satu family, TIDAK PERNAH direset oleh rotasi) sudah
 * lewat. Tabel ini terus bertambah setiap kali user login (satu baris
 * per sesi/device, lihat komentar desain di `prisma/schema.prisma`)
 * dan TIDAK PERNAH dibersihkan otomatis sebelumnya — baris yang
 * lolos salah satu kondisi di atas sama sekali tidak berguna lagi
 * untuk `AuthService.refresh`, jadi aman dihapus permanen.
 *
 * Kondisi `familySessionExpiresAt` di sini PENTING sendiri (bukan
 * cuma redundan dengan `expiresAt`): sesi yang TERUS-MENERUS dirotasi
 * (mis. refresh token dicuri lalu dipakai attacker secara rutin, atau
 * app mobile yang auto-refresh) tidak pernah lewat `expiresAt`
 * rolling-nya, tapi TETAP harus dianggap mati begitu melewati batas
 * absolut — tanpa baris ini, baris semacam itu akan terus tampak
 * "aktif" di `GET /auth/sessions` sampai ada percobaan `refresh()`
 * berikutnya yang baru men-trigger pengecekan di `AuthService.refresh`.
 *
 * Jadwal: setiap hari jam 02:00 — di luar jam sibuk, dan cukup sering
 * supaya tabel tidak sempat membengkak signifikan antar-pembersihan.
 */
async function cleanupExpiredRefreshTokens(): Promise<JobRunSummary> {
  const now = new Date();
  const result = await prisma.refreshToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: now } }, { familySessionExpiresAt: { lt: now } }] },
  });

  return {
    message: `${result.count} refresh token kedaluwarsa dihapus`,
    details: { deletedCount: result.count },
  };
}

export const cleanupExpiredRefreshTokensJob: ScheduledJobDefinition = {
  name: 'cleanup-expired-refresh-tokens',
  cronExpression: '0 2 * * *',
  run: cleanupExpiredRefreshTokens,
};
