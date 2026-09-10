// Konfigurasi bersama untuk seluruh skrip k6 di folder ini (Phase 12
// upgrade — Performance Test). Diimpor lewat relative path karena k6
// TIDAK menjalankan lewat Node/npm — ini dieksekusi oleh binary `k6`
// sendiri (`k6 run performance-tests/login-load.js`), jadi TIDAK ada
// `node_modules` yang bisa diresolve di sini, hanya file lokal.
//
// Target proyek (sesuai spesifikasi upgrade): p95 response time < 500ms.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

/**
 * Threshold standar dipakai di SETIAP skrip — k6 akan menandai run
 * sebagai GAGAL (exit code != 0, cocok untuk gate di CI/CD Phase 13)
 * kalau salah satu threshold ini dilanggar, bukan hanya laporan pasif.
 */
export const standardThresholds = {
  // Target utama: 95th percentile < 500ms.
  http_req_duration: ['p(95)<500'],
  // Error rate request HTTP (status >=400 dihitung gagal oleh k6
  // secara default lewat `http_req_failed`) harus di bawah 1% —
  // beberapa kegagalan transient masih ditoleransi, lonjakan error
  // tidak.
  http_req_failed: ['rate<0.01'],
};

/**
 * Profil beban bertahap (ramping) — dipakai seluruh skrip supaya
 * hasil antar skrip bisa dibandingkan apel-ke-apel. Naik bertahap
 * (bukan langsung ke puncak) supaya throughput/error rate yang
 * terukur mencerminkan sistem dalam kondisi stabil, bukan lonjakan
 * koneksi sesaat yang menyesatkan.
 */
export const standardStages = [
  { duration: '30s', target: 20 }, // ramp-up bertahap
  { duration: '1m', target: 50 }, // beban stabil — concurrent user "normal"
  { duration: '30s', target: 100 }, // uji ketahanan di beban lebih tinggi
  { duration: '30s', target: 0 }, // ramp-down
];
