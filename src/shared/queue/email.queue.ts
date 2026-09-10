import { Queue } from 'bullmq';
import { queueConnection } from './connection';
import { mailer } from '../utils/mailer';
import { bullMQTelemetry } from '../observability/bullmq-telemetry';

export type EmailJobData =
  | { type: 'verification'; to: string; token: string }
  | { type: 'password-reset'; to: string; token: string }
  // Suspicious Session Detection — dikirim saat login berhasil dari
  // device (User-Agent + IP) yang belum pernah tercatat sebelumnya
  // untuk user tsb, lihat
  // `AuthService.detectAndRecordSuspiciousLogin`. `deviceName` sudah
  // dalam bentuk siap-tampil (mis. "Chrome di Windows"), hasil parse
  // yang sama dipakai `SessionDto` (`shared/utils/user-agent.ts`) —
  // isi email tidak perlu tahu cara parsing User-Agent mentah.
  | { type: 'suspicious-login'; to: string; deviceName: string; ipAddress: string | null };

/**
 * `null` kalau Redis tidak dikonfigurasi — lihat `connection.ts`.
 * `enqueueEmailJob` di bawah menangani kasus ini dengan fallback ke
 * eksekusi sinkron, bukan melempar error.
 *
 * `defaultJobOptions` (Phase 10 upgrade — Queue Professional):
 * - `attempts: 5` + `backoff` eksponensial (mulai 2 detik, dua kali
 *   lipat tiap percobaan: 2s, 4s, 8s, 16s) — provider email pihak
 *   ketiga (SMTP/SES/dst di baliknya) sering gagal SEMENTARA (rate
 *   limit, downtime singkat), bukan gagal permanen; retry dengan jeda
 *   yang membesar memberi provider waktu pulih tanpa membombardirnya.
 * - `removeOnComplete: { count: 1000 }` — job sukses tidak perlu
 *   disimpan selamanya (tidak ada nilai investigasi), tapi tetap
 *   menyisakan riwayat terbatas untuk debugging/Bull Board, bukan
 *   dihapus instan (`removeOnComplete: true` bawaan) yang membuat
 *   dashboard selalu terlihat kosong.
 * - `removeOnFail: { count: 5000 }` — job gagal (bahkan setelah
 *   habis attempts) tetap disimpan lebih lama karena LEBIH berharga
 *   untuk investigasi daripada job sukses.
 */
export const emailQueue = queueConnection
  ? new Queue<EmailJobData>('email', {
      connection: queueConnection,
      telemetry: bullMQTelemetry ?? undefined,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    })
  : null;

/**
 * Titik masuk TUNGGAL untuk mengirim email dari mana pun di aplikasi
 * (`AuthService`, dst) — pemanggil tidak perlu tahu apakah request
 * mereka benar-benar diproses lewat antrian BullMQ (worker terpisah,
 * lihat `src/workers/email.worker.ts`) atau dieksekusi langsung di
 * tempat. Ini yang membuat HTTP response untuk `/register` atau
 * `/forgot-password` TIDAK PERNAH menunggu proses "pengiriman" email
 * selesai — job masuk antrian dalam hitungan milidetik, request
 * langsung direspons.
 */
export async function enqueueEmailJob(data: EmailJobData): Promise<void> {
  if (emailQueue) {
    await emailQueue.add(data.type, data);
    return;
  }

  // Redis tidak dikonfigurasi — jalankan langsung secara sinkron,
  // konsisten dengan pola graceful-degradation di seluruh aplikasi
  // (cache, OAuth, dsb): fitur tambahan tidak boleh membuat fungsi
  // inti (mengirim email verifikasi/reset) gagal total.
  await processEmailJob(data);
}

/**
 * Logic pemrosesan sesungguhnya — dipakai OLEH `email.worker.ts`
 * (mode antrian sungguhan) MAUPUN oleh `enqueueEmailJob` di atas
 * (mode fallback sinkron). Satu-satunya tempat yang tahu bagaimana
 * caranya "mengirim" tiap jenis email, supaya kedua mode tidak
 * pernah berbeda perilaku.
 */
export async function processEmailJob(data: EmailJobData): Promise<void> {
  if (data.type === 'verification') {
    await mailer.send({
      to: data.to,
      subject: 'Verifikasi Email Anda',
      text: `Gunakan token berikut untuk verifikasi akun (berlaku 24 jam): ${data.token}`,
    });
    return;
  }

  if (data.type === 'password-reset') {
    await mailer.send({
      to: data.to,
      subject: 'Reset Password Anda',
      text: `Gunakan token berikut untuk reset password (berlaku 1 jam): ${data.token}`,
    });
    return;
  }

  await mailer.send({
    to: data.to,
    subject: 'Login Baru Terdeteksi dari Device Belum Dikenal',
    text:
      `Kami mendeteksi login berhasil ke akun Anda dari device baru: ${data.deviceName}` +
      (data.ipAddress ? ` (IP: ${data.ipAddress})` : '') +
      `. Kalau ini bukan Anda, segera cabut sesi tsb lewat halaman keamanan akun dan ganti password Anda.`,
  });
}
