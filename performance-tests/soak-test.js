import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './k6.config.js';

/**
 * Soak Test (Phase 21 — Enterprise Quality) — BEDA dari 3 test lain
 * di folder ini: bukan tentang beban TINGGI (stress/spike), tapi
 * beban MODERAT yang bertahan LAMA. Tujuannya menemukan masalah yang
 * HANYA muncul seiring waktu, yang tidak akan pernah kelihatan dari
 * run singkat (beberapa menit): memory leak (heap terus naik tanpa
 * pernah turun — event listener yang tidak pernah dilepas, cache
 * yang tidak pernah di-evict), koneksi database/Redis yang perlahan
 * bocor (tidak pernah dikembalikan ke pool), atau degradasi
 * performa bertahap yang baru kelihatan setelah puluhan ribu request
 * kumulatif.
 *
 * DURASI DEFAULT DI SINI SENGAJA DIPERSINGKAT (15 menit, bukan
 * berjam-jam) — supaya tetap PRAKTIS dijalankan sebagai verifikasi
 * awal/demo. Soak test yang SUNGGUHAN bermakna biasanya 4-24 jam;
 * override lewat env var `SOAK_DURATION` untuk itu:
 *   k6 run -e SOAK_DURATION=4h performance-tests/soak-test.js
 *
 * SELAMA run, pantau `kubectl top pod`/Grafana (Phase 16) untuk
 * memori proses API — k6 sendiri TIDAK mengukur memori SERVER (cuma
 * response time dari sisi client), jadi deteksi memory leak
 * sungguhan butuh dashboard terpisah berjalan bersamaan.
 *
 * Jalankan: k6 run performance-tests/soak-test.js
 */
const SOAK_DURATION = __ENV.SOAK_DURATION || '15m';

export const options = {
  stages: [
    { duration: '1m', target: 30 }, // ramp-up ke beban moderat
    { duration: SOAK_DURATION, target: 30 }, // TAHAN di beban moderat — inilah inti soak test, durasi panjang di beban STABIL (bukan naik-turun seperti test lain)
    { duration: '1m', target: 0 },
  ],
  thresholds: {
    // KETAT lagi (beda dari stress/spike) — di beban MODERAT yang
    // konstan, sistem SEHARUSNYA tetap memenuhi target performa
    // normal SEPANJANG durasi; kalau p95 mulai melebihi ini di
    // PERTENGAHAN run (bukan dari awal), itu justru sinyal degradasi
    // seiring waktu yang jadi tujuan utama soak test mendeteksinya.
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function soakTest() {
  const response = http.get(`${BASE_URL}/health`);
  check(response, { 'status 200': (r) => r.status === 200 });
  sleep(1); // Interval antar-request LEBIH SANTAI dari load/stress/spike — soak test mensimulasikan traffic organik yang bertahan lama, bukan memaksimalkan throughput sesaat.
}
