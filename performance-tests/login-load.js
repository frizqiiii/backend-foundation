import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, standardThresholds, standardStages } from './k6.config.js';

/**
 * Login Load Test (Phase 12) — mengukur `POST /api/v1/auth/login`
 * di bawah beban concurrent user yang naik bertahap.
 *
 * PRASYARAT sebelum menjalankan: akun test HARUS sudah ada &
 * ter-verifikasi di database target (`AuthService.login` menolak
 * email belum diverifikasi — lihat `auth.service.ts`). Skrip ini
 * SENGAJA tidak mendaftarkan akun sendiri di dalam load test — proses
 * `register` mengantre email verifikasi (`enqueueEmailJob`) yang
 * bukan bagian dari apa yang diukur di sini, dan lebih penting: akun
 * baru tidak akan lolos pengecekan `emailVerifiedAt`.
 *
 * Jalankan:
 *   k6 run -e BASE_URL=http://localhost:3000 \
 *          -e LOGIN_EMAIL=loadtest@example.com \
 *          -e LOGIN_PASSWORD='Password123' \
 *          performance-tests/login-load.js
 */
const loginErrors = new Rate('login_errors');
const loginDuration = new Trend('login_duration', true);

const LOGIN_EMAIL = __ENV.LOGIN_EMAIL || 'loadtest@example.com';
const LOGIN_PASSWORD = __ENV.LOGIN_PASSWORD || 'Password123';

export const options = {
  stages: standardStages,
  thresholds: {
    ...standardThresholds,
    login_errors: ['rate<0.01'],
  },
};

export default function loginLoadTest() {
  const response = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const success = check(response, {
    'status adalah 200': (r) => r.status === 200,
    'response berisi accessToken': (r) => {
      try {
        return typeof JSON.parse(r.body).data.accessToken === 'string';
      } catch {
        return false;
      }
    },
  });

  loginErrors.add(!success);
  loginDuration.add(response.timings.duration);

  // Jeda singkat antar iterasi virtual user — mensimulasikan jeda
  // "berpikir" manusia sungguhan, bukan spam request tanpa henti yang
  // tidak realistis dibandingkan trafik produksi.
  sleep(1);
}
