import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, standardThresholds } from './k6.config.js';

/**
 * Export & Queue Load Test (Langkah 5 audit — sebelum ini TIDAK ADA
 * k6 test yang mengukur alur ASYNC lewat BullMQ sama sekali; skrip
 * lain di folder ini (`*-crud-load.js`, `login-load.js`,
 * `upload-load.js`) semuanya mengukur request SINKRON — response
 * langsung jadi, tidak ada job yang diproses worker terpisah).
 *
 * `POST /api/v1/exports` sengaja dipilih sebagai representative case
 * untuk "queue test" secara umum (bukan hanya "export test") — beban
 * kerjanya PALING mirip dengan job queue lain di aplikasi ini (lihat
 * `export.worker.ts`): enqueue cepat (respons request TIDAK menunggu
 * job selesai), lalu polling status sampai job SELESAI diproses
 * worker. Metric `export_job_completion_seconds` di sini pada
 * dasarnya mengukur throughput worker BullMQ di bawah beban
 * concurrent — bukan cuma satu endpoint export itu sendiri.
 *
 * Concurrency SENGAJA rendah & TIDAK bertahap sampai 100 seperti
 * `login-load.js`/`event-crud-load.js` — sama alasannya dengan
 * `upload-load.js`: generate export (query ribuan baris + serialisasi
 * file) jauh lebih berat per job daripada request CRUD biasa, dan
 * `EXPORT_QUEUE_CONCURRENCY` (default 2, lihat `env.ts`) SENGAJA
 * dibatasi rendah di worker — beban tinggi di sini hanya akan
 * mengukur antrian menumpuk, bukan performa aplikasi yang berguna.
 *
 * PRASYARAT: akun test HARUS role ADMIN (`dashboard.read` — satu-
 * satunya role yang punya permission ini, lihat `permissions.ts`),
 * BEDA dari skrip lain di folder ini yang cukup role USER biasa.
 *
 * Jalankan:
 *   k6 run -e BASE_URL=http://localhost:3000 \
 *          -e EXPORT_ADMIN_EMAIL=admin@example.com \
 *          -e EXPORT_ADMIN_PASSWORD='Password123' \
 *          performance-tests/export-queue-load.js
 */
const exportErrors = new Rate('export_errors');
const exportJobCompletionSeconds = new Trend('export_job_completion_seconds', true);

const EXPORT_ADMIN_EMAIL = __ENV.EXPORT_ADMIN_EMAIL || 'admin@example.com';
const EXPORT_ADMIN_PASSWORD = __ENV.EXPORT_ADMIN_PASSWORD || 'Password123';

// Berapa lama menunggu SATU job export selesai sebelum dianggap
// gagal (bukan berapa lama test-nya berjalan) — export yang mandek
// >30 detik dengan beban rendah di sini adalah sinyal bottleneck
// worker yang layak diselidiki, bukan sekadar lambat wajar.
const MAX_POLL_ATTEMPTS = 15;
const POLL_INTERVAL_SECONDS = 2;

export const options = {
  stages: [
    { duration: '15s', target: 3 },
    { duration: '1m', target: 8 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    // TIDAK memakai `standardThresholds` apa adanya — `http_req_duration`
    // standar (p95 < 500ms) HANYA relevan untuk request SINKRON;
    // `POST /exports` sendiri memang cepat (cuma enqueue), tapi kalau
    // dipakai untuk keseluruhan skrip ini metric-nya akan tercampur
    // dengan request polling yang jumlahnya jauh lebih banyak per
    // iterasi (menyesatkan, bukan mengukur apa yang sebenarnya
    // ingin diukur di sini).
    http_req_failed: standardThresholds.http_req_failed,
    export_errors: ['rate<0.05'],
    // Threshold UTAMA skrip ini — job export (beban ringan, tipe
    // DASHBOARD_STATS/CSV) harus selesai dalam <15 detik p95 di
    // bawah beban concurrent yang diuji di atas.
    export_job_completion_seconds: ['p(95)<15'],
  },
};

export function setup() {
  const loginResponse = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: EXPORT_ADMIN_EMAIL, password: EXPORT_ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginResponse.status !== 200) {
    throw new Error(
      `Setup gagal login (status ${loginResponse.status}) — pastikan akun EXPORT_ADMIN_EMAIL punya role ADMIN & sudah terverifikasi.`
    );
  }

  return { accessToken: JSON.parse(loginResponse.body).data.accessToken };
}

export default function exportQueueLoadTest(data) {
  const authHeaders = { headers: { Authorization: `Bearer ${data.accessToken}` } };
  const startedAt = Date.now();

  const createResponse = http.post(
    `${BASE_URL}/api/v1/exports`,
    JSON.stringify({ type: 'DASHBOARD_STATS', format: 'CSV' }),
    {
      headers: { ...authHeaders.headers, 'Content-Type': 'application/json' },
    }
  );

  const created = check(createResponse, {
    'POST /exports -> 201/202': (r) => r.status === 201 || r.status === 202,
  });

  if (!created) {
    exportErrors.add(1);
    sleep(1);
    return;
  }

  const jobId = JSON.parse(createResponse.body).data.id;

  // Polling — pola SAMA seperti client sungguhan akan lakukan (tidak
  // ada webhook/push notification untuk status export di aplikasi
  // ini, lihat `export.routes.ts`): `GET /exports/:id` berulang
  // sampai `status` bukan lagi PENDING/PROCESSING.
  let finalStatus = null;
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
    sleep(POLL_INTERVAL_SECONDS);

    const statusResponse = http.get(`${BASE_URL}/api/v1/exports/${jobId}`, authHeaders);
    if (statusResponse.status !== 200) {
      break;
    }

    const status = JSON.parse(statusResponse.body).data.status;
    if (status === 'COMPLETED' || status === 'FAILED') {
      finalStatus = status;
      break;
    }
  }

  const succeeded = check(
    { finalStatus },
    { 'export job -> COMPLETED (sebelum timeout polling)': (r) => r.finalStatus === 'COMPLETED' }
  );

  exportErrors.add(!succeeded);
  if (succeeded) {
    exportJobCompletionSeconds.add((Date.now() - startedAt) / 1000);
  }
}
