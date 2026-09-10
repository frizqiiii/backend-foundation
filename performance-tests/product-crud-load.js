import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';
import { BASE_URL, standardThresholds, standardStages } from './k6.config.js';

/**
 * CRUD Product Load Test (Phase 20 — Performance Test Complete).
 * Mengikuti pola PERSIS `event-crud-load.js`, dengan SATU perbedaan
 * struktural yang mengikuti bentuk API `products` YANG SUNGGUHAN
 * (lihat `product.routes.ts`) — modul ini TIDAK punya `GET /:id`
 * (detail satu produk) maupun `PATCH /:id` (update field bebas):
 * - CREATE  -> `POST /api/v1/products`
 * - READ    -> `GET /api/v1/products` (list saja — TIDAK ada endpoint
 *              detail per-produk di API ini, jadi TIDAK diukur di sini,
 *              bukan lupa)
 * - UPDATE  -> `PATCH /api/v1/products/:id/upgrade` (satu-satunya
 *              endpoint yang mengubah field produk yang sudah ada —
 *              lihat `ProductService.upgradeProduct`)
 * - DELETE  -> `DELETE /api/v1/products/:id` (soft delete)
 *
 * PRASYARAT: akun test harus role ORGANIZER atau ADMIN (`product.create`
 * — role USER TIDAK memilikinya, lihat `permissions.ts`) dan sudah
 * ter-verifikasi email.
 * Produk baru otomatis `category: STANDARD, status: ACTIVE, stock: 1`
 * (default skema) — memenuhi SELURUH syarat `upgradeProduct`
 * (status ACTIVE, stock > 0, kategori tujuan FEATURED > STANDARD)
 * tanpa perlu setup tambahan.
 *
 * Jalankan:
 *   k6 run -e BASE_URL=http://localhost:3000 \
 *          -e PRODUCT_TEST_EMAIL=loadtest@example.com \
 *          -e PRODUCT_TEST_PASSWORD='Password123' \
 *          performance-tests/product-crud-load.js
 */
const crudErrors = new Rate('product_crud_errors');

const PRODUCT_TEST_EMAIL = __ENV.PRODUCT_TEST_EMAIL || 'loadtest@example.com';
const PRODUCT_TEST_PASSWORD = __ENV.PRODUCT_TEST_PASSWORD || 'Password123';

export const options = {
  stages: standardStages,
  thresholds: {
    ...standardThresholds,
    product_crud_errors: ['rate<0.01'],
  },
};

export function setup() {
  const loginResponse = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ email: PRODUCT_TEST_EMAIL, password: PRODUCT_TEST_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (loginResponse.status !== 200) {
    throw new Error(
      `Setup gagal login (status ${loginResponse.status}) — pastikan akun PRODUCT_TEST_EMAIL sudah ada & terverifikasi.`
    );
  }

  return { accessToken: JSON.parse(loginResponse.body).data.accessToken };
}

export default function productCrudLoadTest(data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.accessToken}`,
  };

  // CREATE
  const createResponse = http.post(
    `${BASE_URL}/api/v1/products`,
    JSON.stringify({
      title: `Product Load Test ${__VU}-${__ITER}`,
      description: 'Dibuat oleh k6 performance test',
      price: 10000,
      stock: 5,
    }),
    { headers }
  );

  const createOk = check(createResponse, { 'create -> 201': (r) => r.status === 201 });
  crudErrors.add(!createOk);
  if (!createOk) {
    sleep(1);
    return;
  }
  const productId = JSON.parse(createResponse.body).data.id;

  // READ (list — lihat catatan di atas soal tidak adanya endpoint detail)
  const listResponse = http.get(`${BASE_URL}/api/v1/products?page=1&limit=10`);
  crudErrors.add(!check(listResponse, { 'list -> 200': (r) => r.status === 200 }));

  // UPDATE (satu-satunya jalur perubahan field produk yang ada: upgrade kategori)
  const upgradeResponse = http.patch(
    `${BASE_URL}/api/v1/products/${productId}/upgrade`,
    JSON.stringify({ toCategory: 'FEATURED' }),
    { headers }
  );
  crudErrors.add(!check(upgradeResponse, { 'upgrade -> 200': (r) => r.status === 200 }));

  // DELETE (soft delete — lihat `Product.deletedAt` di schema.prisma)
  const deleteResponse = http.del(`${BASE_URL}/api/v1/products/${productId}`, null, { headers });
  crudErrors.add(!check(deleteResponse, { 'delete -> 200': (r) => r.status === 200 }));

  sleep(1);
}
