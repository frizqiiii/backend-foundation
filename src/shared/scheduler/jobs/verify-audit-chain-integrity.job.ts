import { prisma } from '../../config/database';
import { AuditRepository } from '../../../modules/audit/audit.repository';
import type { ScheduledJobDefinition, JobRunSummary } from '../scheduler.types';

/**
 * Memverifikasi SELURUH hash chain `audit_logs` (lihat
 * `AuditRepository.verifyChainIntegrity` untuk desain lengkap) —
 * operasi ini SENGAJA dijadwalkan (bukan dihitung ulang di setiap
 * request), karena membaca & meng-hash ulang SEMUA baris berhash
 * setiap kali; untuk tabel audit log yang terus bertambah, itu
 * mahal dilakukan sering-sering, tapi murah cukup dijalankan sekali
 * sehari untuk tujuan tamper-DETECTION (bukan tamper-PREVENTION —
 * pencegahannya sudah di trigger database WORM, job ini lapis
 * DETEKSI independen untuk kasus trigger itu entah bagaimana
 * terlewati).
 *
 * SENGAJA `throw`, BUKAN mengembalikan summary "gagal" biasa — lihat
 * kontrak `ScheduledJobDefinition.run` (job TIDAK BOLEH menelan error
 * sendiri) — begitu chain terdeteksi rusak, ini harus melalui jalur
 * penanganan kegagalan job yang SAMA seperti error lain (log level
 * error + alerting), bukan cuma baris log info biasa yang gampang
 * terlewat.
 *
 * Jadwal: setiap hari jam 03:00 — di luar jam sibuk, dan sesudah job
 * cleanup lain (02:15/02:30-an) supaya tidak bersaing beban database.
 */
async function verifyAuditChainIntegrity(): Promise<JobRunSummary> {
  const auditRepository = new AuditRepository(prisma);
  const result = await auditRepository.verifyChainIntegrity();

  if (!result.valid) {
    throw new Error(
      `Audit log hash chain TIDAK VALID — kemungkinan ada baris yang diubah/dihapus/disisipkan di luar jalur normal. ` +
        `Baris bermasalah: id=${result.brokenAt.id}, alasan: ${result.brokenAt.reason}`
    );
  }

  return {
    message: 'Audit log hash chain terverifikasi valid — tidak ada indikasi tampering.',
  };
}

export const verifyAuditChainIntegrityJob: ScheduledJobDefinition = {
  name: 'verify-audit-chain-integrity',
  cronExpression: '0 3 * * *',
  run: verifyAuditChainIntegrity,
};
