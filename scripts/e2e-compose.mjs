#!/usr/bin/env node
// E2E terhadap stack Docker Compose yang SUDAH berjalan (`docker compose up -d`, migrate + seed selesai).
//
// Kenapa ada: perilaku multi-tenant lintas-middleware (header tenant, pengikatan identitas, RLS di bawah role
// non-superuser) hanya terbukti kalau diuji lewat HTTP terhadap database sungguhan. Tes unit me-mock database, dan
// `npm run test:rls` menguji repository, bukan rantai middleware. Skrip ini mengunci hasil probe temuan S1, R15, R20b,
// R22, dan R23 menjadi regresi yang bisa diulang.
//
// Memakai data seed: admin@example.com (tenant "default") dan user@acme.example.com (tenant "acme"), keduanya
// Password123. Menulis data dev sementara (1 API key, 1 produk) dan membersihkannya di akhir. Zero-dependency (Node >= 18).
// `/auth/*` dibatasi 10 request per 15 menit per IP; skrip ini memakai 1 login, jadi aman dijalankan beberapa kali.
//
// Pakai:  npm run test:e2e:compose        (BASE_URL=http://localhost:3000/api/v1 secara default)
// Menunggu /health sampai E2E_WAIT_SECONDS (default 90) sebelum mulai, supaya aman tepat setelah `up -d`.
// Keluar dengan kode 1 kalau ada asersi gagal.
const BASE = process.env.BASE_URL ?? 'http://localhost:3000/api/v1';
const ORIGIN = new URL(BASE).origin;
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com',
  password: process.env.E2E_PASSWORD ?? 'Password123',
};

let failed = 0;
let passed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (ok) passed++;
  else failed++;
}

async function api(method, path, { token, tenant, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (tenant) headers['X-Tenant-ID'] = tenant;
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = crypto.randomUUID();
  }
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const dataOf = (r) => (r.json && r.json.data) ?? null;
const ids = (r) => (Array.isArray(dataOf(r)) ? dataOf(r).map((x) => x.id) : []);

// `docker compose up -d` kembali begitu container *dimulai*, bukan saat aplikasi siap (kompilasi + koneksi DB/Redis
// masih berjalan). Start dingin ditemukan gagal tanpa tunggu ini, jadi poll /health sampai 200 atau batas waktu.
const WAIT_SECONDS = Number(process.env.E2E_WAIT_SECONDS ?? 90);
async function waitForHealth() {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let res = null;
  let announced = false;
  for (;;) {
    res = await fetch(ORIGIN + '/health', { signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (res?.status === 200 || Date.now() >= deadline) return res;
    if (!announced) {
      console.log(`menunggu aplikasi sehat (maks ${WAIT_SECONDS} detik)...`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const cleanup = [];
try {
  const health = await waitForHealth();
  check('GET /health', health?.status === 200, `http=${health?.status ?? 'tidak terjangkau'}`);
  if (health?.status !== 200) {
    throw new Error(`aplikasi belum sehat setelah ${WAIT_SECONDS} detik; cek \`docker compose ps\` dan \`docker compose logs backend_app\``);
  }

  const login = await api('POST', '/auth/login', { body: ADMIN });
  const jwt = dataOf(login)?.accessToken;
  if (!jwt) {
    throw new Error(`login gagal http=${login.status} (429 = batas /auth/*; reset key rate_limit:auth:* di redis)`);
  }

  // S1 — header tenant harus milik identitas pemanggil.
  const own = await api('GET', '/api-keys', { token: jwt, tenant: 'default' });
  const foreign = await api('GET', '/api-keys', { token: jwt, tenant: 'acme' });
  check('S1  JWT + header tenant sendiri -> 200', own.status === 200, `http=${own.status}`);
  check('S1  JWT + header tenant LAIN -> 403', foreign.status === 403, `http=${foreign.status}`);

  // R15 — daftar produk per tenant, tanpa header kosong (RLS fail-closed).
  const pDefault = await api('GET', '/products?page=1&limit=50', { tenant: 'default' });
  const pAcme = await api('GET', '/products?page=1&limit=50', { tenant: 'acme' });
  const pNone = await api('GET', '/products?page=1&limit=50');
  check('R15  produk tenant default tidak kosong', ids(pDefault).length > 0, `items=${ids(pDefault).length}`);
  check('R15  produk tenant acme tidak kosong', ids(pAcme).length > 0, `items=${ids(pAcme).length}`);
  check(
    'R15  produk dua tenant tidak beririsan',
    ids(pDefault).every((id) => !ids(pAcme).includes(id)),
  );
  check('R15  tanpa header -> 0 produk', pNone.status === 200 && ids(pNone).length === 0, `items=${ids(pNone).length}`);

  // R23 — API key berjalan di tenant miliknya walau header tidak dikirim.
  const created = await api('POST', '/api-keys', { token: jwt, tenant: 'default', body: { name: 'e2e-compose-' + Date.now() } });
  const raw = dataOf(created)?.rawKey;
  const keyId = dataOf(created)?.id;
  check('R23  buat API key (JWT + header default)', created.status === 201 && !!raw, `http=${created.status}`);
  if (keyId) cleanup.push(() => api('DELETE', '/api-keys/' + keyId, { token: jwt, tenant: 'default' }));
  if (raw) {
    const keyNoHeader = await api('GET', '/api-keys', { token: raw });
    check(
      'R23  key tanpa header melihat key miliknya sendiri',
      keyNoHeader.status === 200 && ids(keyNoHeader).includes(keyId),
      `http=${keyNoHeader.status} items=${ids(keyNoHeader).length}`
    );
    const keyForeign = await api('GET', '/api-keys', { token: raw, tenant: 'acme' });
    check('R23  key + header tenant LAIN -> 403', keyForeign.status === 403, `http=${keyForeign.status}`);
    const product = await api('POST', '/products', {
      token: raw,
      body: { title: 'e2e-compose-' + Date.now(), description: 'produk uji e2e compose', price: 1000, stock: 1 },
    });
    check('R23  POST /products dengan key tanpa header -> 201', product.status === 201, `http=${product.status}`);
    const productId = dataOf(product)?.id;
    if (productId) cleanup.push(() => api('DELETE', '/products/' + productId, { token: jwt, tenant: 'default' }));
  }
  const bogus = await api('GET', '/api-keys', { token: 'bfk_' + 'x'.repeat(40) });
  check('R23  key palsu -> 401', bogus.status === 401, `http=${bogus.status}`);

  // R20b — nama event tak dikenal ditolak saat mendaftar webhook (tidak ada endpoint yang terbentuk).
  const hook = await api('POST', '/webhooks', {
    token: jwt,
    tenant: 'default',
    body: { url: 'https://example.com/e2e-compose', eventTypes: ['prduct.created'] },
  });
  check('R20b  eventTypes salah ketik -> 422', hook.status === 422, `http=${hook.status}`);
  const hookId = dataOf(hook)?.id;
  if (hookId) cleanup.push(() => api('DELETE', '/webhooks/' + hookId, { token: jwt, tenant: 'default' }));

  // R22 — tipe export yang sumbernya tidak punya tenant_id ditolak untuk request ber-tenant.
  for (const type of ['AUDIT_LOG', 'SYSTEM_STATISTICS', 'DAILY_ACTIVE_USERS']) {
    const exp = await api('POST', '/exports', { token: jwt, tenant: 'default', body: { type, format: 'CSV' } });
    check(`R22  export ${type} ber-tenant -> 403`, exp.status === 403, `http=${exp.status}`);
  }
} catch (err) {
  failed++;
  console.log('FAIL  ' + (err instanceof Error ? err.message : String(err)));
} finally {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
}

console.log(`\n${passed} lulus, ${failed} gagal`);
process.exit(failed === 0 ? 0 : 1);
