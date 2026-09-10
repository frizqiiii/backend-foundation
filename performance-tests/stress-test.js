import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './k6.config.js';

/**
 * Stress Test (Phase 21 — Enterprise Quality) — BEDA TUJUAN dari
 * Load Test (`login-load.js` dkk): Load Test memverifikasi sistem
 * MEMENUHI target (p95<500ms, error<1%) di beban NORMAL/tinggi yang
 * REALISTIS (puncak 100 VU). Stress Test justru SENGAJA melewati
 * batas realistis itu — tujuannya menemukan DI TITIK BEBAN BERAPA
 * sistem mulai gagal (response time meledak, error rate naik tajam,
 * atau proses API mati/OOM), bukan memverifikasi lulus/gagal
 * terhadap satu threshold pasti.
 *
 * `thresholds` di sini SENGAJA LEBIH LONGGAR (bukan disalin dari
 * `standardThresholds`) — kalau dipaksa p95<500ms di beban 500 VU,
 * test ini akan "gagal" di awal ramp-up dan k6 exit lebih cepat,
 * padahal yang justru ingin diamati adalah PERILAKU sistem SETELAH
 * melewati kapasitas normalnya (degradasi graceful vs crash total).
 *
 * Endpoint yang diuji: `GET /health` — SENGAJA endpoint paling ringan
 * (Phase 18: liveness, TIDAK menyentuh database/Redis sama sekali,
 * lihat `health.controller.ts`) supaya stress yang terukur adalah
 * kapasitas Express/Node murni (event loop, koneksi TCP), bukan
 * tercampur kapasitas connection pool database yang punya batas
 * terpisah (`DATABASE_CONNECTION_LIMIT`) — kalau mau stress-test
 * database secara spesifik, ganti target ke endpoint yang query DB
 * (mis. `/api/v1/events`) di run TERPISAH.
 *
 * Jalankan: k6 run performance-tests/stress-test.js
 */
export const options = {
  stages: [
    { duration: '1m', target: 100 }, // ramp ke beban "normal" (baseline sama dengan load test)
    { duration: '2m', target: 300 }, // lewati kapasitas normal — mulai cari titik jebol
    { duration: '2m', target: 500 }, // beban ekstrem — SEBAGIAN BESAR sistem akan mulai degradasi di sini
    { duration: '2m', target: 0 }, // ramp-down — amati apakah sistem PULIH setelah beban turun (recovery), bukan cuma bertahan pas beban tinggi
  ],
  thresholds: {
    // Longgar SENGAJA (bukan p95<500ms) — tujuan run ini MENGAMATI
    // angka sesungguhnya di laporan akhir k6, bukan pass/fail biner.
    // `p(95)<3000` cuma pengaman supaya run yang benar-benar rusak
    // total (mis. server crash, semua request timeout) tetap
    // menghasilkan exit code gagal yang jelas.
    http_req_duration: ['p(95)<3000'],
  },
};

export default function stressTest() {
  const response = http.get(`${BASE_URL}/health`);
  check(response, { 'menerima response (status apa pun < 500 dianggap "hidup")': (r) => r.status < 500 });
}
