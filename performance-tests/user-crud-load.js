import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, standardThresholds, standardStages } from './k6.config.js';

/**
 * CRUD User Load Test (Phase 20 — Performance Test Complete).
 *
 * BEDA STRUKTURAL dari `event-crud-load.js`/`product-crud-load.js`:
 * modul `users` di API ini TIDAK mengekspos verb create/update
 * biasa — akun dibuat lewat `/auth/register` (modul `auth`, bukan
 * `users`) dan TIDAK ADA endpoint untuk mengubah field user manapun
 * (lihat `user.routes.ts`: hanya `GET /me`, `GET /` (admin), dan
 * `DELETE /:id` (admin)). Skrip ini mengukur SIKLUS YANG SUNGGUHAN
 * ADA di API, bukan memaksakan bentuk CRUD generik ke endpoint yang
 * tidak ada:
 * - CREATE  -> `POST /api/v1/auth/register` (satu-satunya jalur user baru dibuat)
 * - READ    -> `GET /api/v1/users/me` (self) + `GET /api/v1/users` (admin, list)
 * - UPDATE  -> TIDAK DIUKUR — tidak ada endpoint update profil user di API ini
 * - DELETE  -> `DELETE /api/v1/users/:id` (admin, `user.manage`)
 *
 * User yang baru diregistrasi TIDAK BISA dipakai login (email belum
 * diverifikasi, lihat catatan yang sama di `login-load.js`) — jadi
 * langkah READ/DELETE di sini dilakukan oleh akun ADMIN terpisah,
 * BUKAN oleh user yang baru dibuat. Ini SEKALIGUS memvalidasi bahwa
 * throwaway user yang dibuat tiap iterasi benar-benar dibersihkan
 * lagi di akhir (DELETE) — load test ini TIDAK meninggalkan data
 * sampah di database target setelah selesai berjalan.
 *
 * PRASYARAT: `ADMIN_EMAIL`/`ADMIN_PASSWORD` harus akun ber-role ADMIN
 * (permission `user.manage`) dan sudah ter-verifikasi email.
 *
 * Jalankan:
 *   k6 run -e BASE_URL=http://localhost:3000 \
 *          -e ADMIN_EMAIL=admin@example.com \
 *          -e ADMIN_PASSWORD='Password123' \
 *          performance-tests/user-crud-load.js
 */
const crudErrors = new Rate('user_crud_errors');

const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'Password123';

export const options = {
  stages: standardStages,
  thresholds: {
    ...standardThresholds,
    user_crud_errors: ['rate<0.01'],
  },
};

export function setup() {
  const loginResponse = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginResponse.status !== 200) {
    throw new Error(
      `Setup gagal login (status ${loginResponse.status}) — pastikan akun ADMIN_EMAIL ada, ber-role ADMIN, dan terverifikasi.`
    );
  }

  return { accessToken: JSON.parse(loginResponse.body).data.accessToken };
}

export default function userCrudLoadTest(data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.accessToken}`,
  };

  // CREATE — throwaway user, email unik per iterasi supaya tidak
  // pernah bentrok `ConflictError` (email sudah terdaftar) antar VU.
  const email = `k6-user-load-${__VU}-${__ITER}-${Date.now()}@example.com`;
  const createResponse = http.post(
    `${BASE_URL}/api/v1/auth/register`,
    JSON.stringify({ name: 'K6 Load Test User', email, password: 'Password123' }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  const createOk = check(createResponse, { 'register -> 201': (r) => r.status === 201 });
  crudErrors.add(!createOk);
  if (!createOk) {
    sleep(1);
    return;
  }
  const userId = JSON.parse(createResponse.body).data.id;

  // READ — self (admin melihat profilnya sendiri) + list admin
  const meResponse = http.get(`${BASE_URL}/api/v1/users/me`, { headers });
  crudErrors.add(!check(meResponse, { 'me -> 200': (r) => r.status === 200 }));

  const listResponse = http.get(`${BASE_URL}/api/v1/users?page=1&limit=10`, { headers });
  crudErrors.add(!check(listResponse, { 'list -> 200': (r) => r.status === 200 }));

  // DELETE — membersihkan throwaway user yang baru dibuat di atas
  const deleteResponse = http.del(`${BASE_URL}/api/v1/users/${userId}`, null, { headers });
  crudErrors.add(!check(deleteResponse, { 'delete -> 200': (r) => r.status === 200 }));

  sleep(1);
}
