import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, standardThresholds } from './k6.config.js';

/**
 * Upload Load Test (Phase 12) — mengukur `POST /api/v1/upload`
 * (multipart) di bawah beban. Concurrency LEBIH RENDAH & TIDAK
 * bertahap sampai 100 seperti dua skrip lain (`login-load.js`,
 * `event-crud-load.js`) — upload file secara inheren jauh lebih berat
 * (I/O ke S3, lihat `upload.service.ts`) daripada request JSON biasa;
 * beban 100 concurrent upload sekaligus TIDAK realistis untuk
 * kebanyakan aplikasi dan berisiko cuma mengukur rate limit S3,
 * bukan performa aplikasi itu sendiri.
 *
 * PRASYARAT: akun test cukup role USER biasa (`upload.create` dimiliki
 * SEMUA role — lihat `permissions.ts`) dan sudah terverifikasi email.
 *
 * Jalankan:
 *   k6 run -e BASE_URL=http://localhost:3000 \
 *          -e UPLOAD_EMAIL=uploader@example.com \
 *          -e UPLOAD_PASSWORD='Password123' \
 *          performance-tests/upload-load.js
 */
const uploadErrors = new Rate('upload_errors');

const UPLOAD_EMAIL = __ENV.UPLOAD_EMAIL || 'uploader@example.com';
const UPLOAD_PASSWORD = __ENV.UPLOAD_PASSWORD || 'Password123';

// File dummy kecil (~1KB) yang di-generate di memori — cukup untuk
// menguji jalur upload tanpa membebani jaringan test runner itu
// sendiri dengan file besar yang tidak representatif.
const DUMMY_FILE_CONTENT = 'x'.repeat(1024);

export const options = {
  stages: [
    { duration: '15s', target: 5 },
    { duration: '1m', target: 15 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    ...standardThresholds,
    upload_errors: ['rate<0.01'],
  },
};

export function setup() {
  const loginResponse = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: UPLOAD_EMAIL, password: UPLOAD_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginResponse.status !== 200) {
    throw new Error(
      `Setup gagal login (status ${loginResponse.status}) — pastikan akun UPLOAD_EMAIL sudah ada & terverifikasi.`
    );
  }

  return { accessToken: JSON.parse(loginResponse.body).data.accessToken };
}

export default function uploadLoadTest(data) {
  const payload = {
    file: http.file(DUMMY_FILE_CONTENT, `k6-load-test-${__VU}-${__ITER}.txt`, 'text/plain'),
  };

  const response = http.post(`${BASE_URL}/api/v1/upload`, payload, {
    headers: { Authorization: `Bearer ${data.accessToken}` },
  });

  uploadErrors.add(!check(response, { 'upload -> 201': (r) => r.status === 201 }));

  sleep(1);
}
