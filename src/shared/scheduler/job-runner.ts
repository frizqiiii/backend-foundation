import { logger } from '../logger';
import { withLock } from '../concurrency/distributed-lock';
import type { ScheduledJobDefinition } from './scheduler.types';

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 2000;

/**
 * TTL lock SENGAJA jauh lebih besar dari waktu eksekusi job yang
 * wajar — tujuannya BUKAN membatasi durasi job, tapi jaring pengaman
 * kalau proses yang memegang lock crash SEBELUM sempat memanggil
 * `releaseLock` (lock tetap otomatis lepas sendiri lewat TTL, bukan
 * terkunci selamanya). 10 menit dipilih karena job terlama saat ini
 * (`database-maintenance.job.ts`) tidak diharapkan berjalan sedekat
 * itu ke batas — kalau suatu saat ada job yang butuh lebih lama,
 * naikkan nilai ini, jangan hilangkan lock-nya.
 */
const JOB_LOCK_TTL_MS = 10 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Menjalankan satu job dengan retry exponential backoff (2s, 4s, 8s)
 * sampai `MAX_ATTEMPTS` percobaan — job scheduler SENGAJA diberi retry
 * lebih longgar daripada request HTTP (yang harus cepat menyerah),
 * karena job seperti "cleanup expired token" tidak punya client yang
 * menunggu response; kegagalan sementara (mis. DB sedang restart)
 * lebih baik dicoba ulang beberapa saat daripada langsung menyerah
 * dan menunggu jadwal berikutnya (bisa berjam-jam lagi).
 *
 * Kegagalan job SATU KALI PUN (setelah seluruh retry habis) TIDAK
 * BOLEH menjatuhkan proses worker — job lain yang terjadwal setelahnya
 * harus tetap bisa berjalan. Errors di sini SELALU ditangkap &
 * di-log, tidak pernah dilempar ulang ke pemanggil (`node-cron`).
 *
 * Phase 14 — SELURUH eksekusi job (termasuk retry-nya) dibungkus SATU
 * distributed lock (`withLock`, key = nama job) — bukan per-attempt.
 * Ini yang membuat komentar lama "worker HARUS single-instance" di
 * `scheduler/index.ts` tidak lagi menjadi syarat keras: kalau suatu
 * saat proses worker di-scale ke beberapa instance/container, HANYA
 * SATU instance yang benar-benar menjalankan tiap job di jendela waktu
 * cron yang sama — instance lain yang gagal mengambil lock cukup
 * melewati tick tersebut (lihat `ran: false` di bawah), bukan ikut
 * menjalankan job yang sama secara dobel.
 */
export async function runJobWithRetry(job: ScheduledJobDefinition): Promise<void> {
  const lockResult = await withLock(`scheduler:${job.name}`, JOB_LOCK_TTL_MS, () =>
    runAttempts(job)
  );

  if (!lockResult.ran) {
    logger.info(
      { job: job.name },
      `Scheduler: job "${job.name}" dilewati tick ini — instance lain sedang/baru saja menjalankannya`
    );
  }
}

async function runAttempts(job: ScheduledJobDefinition): Promise<void> {
  const jobStartedAt = process.hrtime.bigint();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      logger.info({ job: job.name, attempt }, `Scheduler: menjalankan job "${job.name}"`);
      const summary = await job.run();
      const durationMs = Number(process.hrtime.bigint() - jobStartedAt) / 1e6;

      logger.info(
        { job: job.name, attempt, durationMs: Math.round(durationMs), details: summary.details },
        `Scheduler: job "${job.name}" selesai — ${summary.message}`
      );
      return;
    } catch (error) {
      const isLastAttempt = attempt === MAX_ATTEMPTS;
      logger.error(
        { err: error, job: job.name, attempt, isLastAttempt },
        `Scheduler: job "${job.name}" gagal pada percobaan ke-${attempt}${isLastAttempt ? ' — seluruh percobaan habis, dilewati sampai jadwal berikutnya' : ', akan dicoba ulang'}`
      );

      if (isLastAttempt) {
        return;
      }

      const backoffMs = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoffMs);
    }
  }
}
