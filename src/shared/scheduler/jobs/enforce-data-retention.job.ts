import { prisma } from '../../config/database';
import { env } from '../../config/env';
import { UserRepository } from '../../../modules/users/user.repository';
import { UploadRepository } from '../../../modules/upload/upload.repository';
import { PrivacyRepository } from '../../../modules/privacy/privacy.repository';
import { PrivacyService } from '../../../modules/privacy/privacy.service';
import { logger } from '../../logger';
import type { ScheduledJobDefinition, JobRunSummary } from '../scheduler.types';

/**
 * Fase 2 (Kelompok 2 — Data retention policy). Lihat
 * `docs/data-retention-policy.md` untuk kebijakan lengkapnya.
 *
 * Mencari akun yang sudah SOFT-DELETE (`deletedAt` terisi, lewat
 * `DELETE /users/:id` admin) LEBIH LAMA dari
 * `DATA_RETENTION_GRACE_PERIOD_DAYS`, dan otomatis meng-erasure
 * PII-nya (`PrivacyService.eraseForUser` — scrub permanen, sama
 * persis dengan yang dipicu user sendiri lewat
 * `POST /users/me/erasure`).
 *
 * SENGAJA tidak `throw` kalau SATU akun gagal di-erasure — beda dari
 * `verify-audit-chain-integrity.job.ts` yang throw begitu ketahuan
 * SATU masalah (karena itu tanda tampering, harus segera diketahui).
 * Di sini, kegagalan erasure SATU akun (mis. constraint DB tak
 * terduga) tidak boleh menghalangi akun LAIN yang masih dalam antrean
 * yang sama ikut diproses — dicatat sebagai error per-akun, job tetap
 * lanjut, baru melempar SATU ringkasan error di akhir kalau ada yang
 * gagal (supaya tetap masuk jalur alerting, tapi tidak mem-blok
 * seluruh batch).
 */
async function enforceDataRetention(): Promise<JobRunSummary> {
  const userRepository = new UserRepository(prisma);
  const privacyService = new PrivacyService(
    new PrivacyRepository(prisma),
    userRepository,
    new UploadRepository(prisma)
  );

  const cutoff = new Date(Date.now() - env.DATA_RETENTION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await userRepository.findSoftDeletedPastRetentionPeriod(cutoff);

  let erased = 0;
  let failed = 0;
  for (const user of candidates) {
    try {
      await privacyService.eraseForUser(user.id);
      erased++;
    } catch (error) {
      failed++;
      logger.error(
        { err: error, userId: user.id },
        'enforceDataRetention: gagal meng-erasure satu akun — dilanjutkan ke akun berikutnya'
      );
    }
  }

  if (failed > 0) {
    throw new Error(
      `enforceDataRetention: ${erased} akun berhasil di-erasure, ${failed} GAGAL (lihat log error di atas untuk detail per-akun).`
    );
  }

  return {
    message: `${erased} akun soft-deleted (lewat masa tenggang ${env.DATA_RETENTION_GRACE_PERIOD_DAYS} hari) berhasil di-erasure.`,
    details: { erased, candidates: candidates.length },
  };
}

export const enforceDataRetentionJob: ScheduledJobDefinition = {
  name: 'enforce-data-retention',
  // Jam 03:30 UTC -- setelah verify-audit-chain-integrity (03:00),
  // sebelum jam sibuk, tidak bersaing beban database dengan job lain.
  cronExpression: '30 3 * * *',
  run: enforceDataRetention,
};
