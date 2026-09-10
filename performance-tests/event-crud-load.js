import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, standardThresholds, standardStages } from './k6.config.js';

/**
 * CRUD Event Load Test (Phase 12) — mengukur seluruh siklus
 * Create → Read → Update → Delete `POST/GET/PATCH/DELETE
 * /api/v1/events` di bawah beban.
 *
 * PRASYARAT: akun test HARUS role ORGANIZER atau ADMIN (`event.create`
 * — lihat `permissions.ts`) dan sudah ter-verifikasi email.
 *
 * `setup()` login SATU KALI sebelum beban dimulai — access token yang
 * sama dipakai SELURUH virtual user sepanjang test run. Ini SENGAJA:
 * skrip ini mengukur performa CRUD Event, BUKAN performa endpoint
 * login (sudah ada skrip terpisah, `login-load.js`) — mencampur
 * keduanya akan membuat hasil sulit diinterpretasi (lambat karena
 * Event atau karena Login?).
 *
 * Jalankan:
 *   k6 run -e BASE_URL=http://localhost:3000 \
 *          -e ORGANIZER_EMAIL=organizer@example.com \
 *          -e ORGANIZER_PASSWORD='Password123' \
 *          performance-tests/event-crud-load.js
 */
const crudErrors = new Rate('event_crud_errors');

const ORGANIZER_EMAIL = __ENV.ORGANIZER_EMAIL || 'organizer@example.com';
const ORGANIZER_PASSWORD = __ENV.ORGANIZER_PASSWORD || 'Password123';

export const options = {
  stages: standardStages,
  thresholds: {
    ...standardThresholds,
    event_crud_errors: ['rate<0.01'],
  },
};

export function setup() {
  const loginResponse = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: ORGANIZER_EMAIL, password: ORGANIZER_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginResponse.status !== 200) {
    throw new Error(
      `Setup gagal login (status ${loginResponse.status}) — pastikan akun ORGANIZER_EMAIL sudah ada & terverifikasi.`
    );
  }

  return { accessToken: JSON.parse(loginResponse.body).data.accessToken };
}

export default function eventCrudLoadTest(data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.accessToken}`,
  };

  // CREATE
  const createResponse = http.post(
    `${BASE_URL}/api/v1/events`,
    JSON.stringify({
      title: `Event Load Test ${__VU}-${__ITER}`,
      description: 'Dibuat oleh k6 performance test',
      category: 'seminar',
      location: 'Jakarta',
      date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    { headers }
  );

  const createOk = check(createResponse, { 'create -> 201': (r) => r.status === 201 });
  crudErrors.add(!createOk);
  if (!createOk) {
    sleep(1);
    return;
  }
  const eventId = JSON.parse(createResponse.body).data.id;

  // READ (list + detail)
  const listResponse = http.get(`${BASE_URL}/api/v1/events?page=1&limit=10`);
  crudErrors.add(!check(listResponse, { 'list -> 200': (r) => r.status === 200 }));

  const detailResponse = http.get(`${BASE_URL}/api/v1/events/${eventId}`);
  crudErrors.add(!check(detailResponse, { 'detail -> 200': (r) => r.status === 200 }));

  // UPDATE
  const updateResponse = http.patch(
    `${BASE_URL}/api/v1/events/${eventId}`,
    JSON.stringify({ location: 'Bandung' }),
    { headers }
  );
  crudErrors.add(!check(updateResponse, { 'update -> 200': (r) => r.status === 200 }));

  // DELETE (soft delete — lihat `Event.deletedAt` di schema.prisma)
  const deleteResponse = http.del(`${BASE_URL}/api/v1/events/${eventId}`, null, { headers });
  crudErrors.add(!check(deleteResponse, { 'delete -> 200': (r) => r.status === 200 }));

  sleep(1);
}
