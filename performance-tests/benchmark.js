import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE_URL } from './k6.config.js';

/**
 * Performance Benchmark (Phase 21 — Enterprise Quality) — BEDA
 * TUJUAN dari Load/Stress/Spike/Soak Test di folder yang sama:
 * keempatnya menguji PERILAKU sistem di bawah tekanan; benchmark ini
 * mengukur BASELINE latency di kondisi TENANG (concurrency rendah,
 * TANPA persaingan resource) — angka yang dimaksudkan untuk
 * DIBANDINGKAN ANTAR RILIS ("apakah endpoint ini jadi lebih lambat
 * dibanding minggu lalu?"), bukan untuk dites lulus/gagal sekali
 * jalan.
 *
 * `vus: 1` SENGAJA — beban konkuren dari test lain (Load/Stress/
 * Spike) akan membuat angka latency naik-turun tergantung berapa
 * banyak request BERSAMAAN, itu mengukur KAPASITAS, bukan kecepatan
 * MURNI satu request. Benchmark yang berguna untuk regresi harus
 * mengisolasi variabel itu — satu request pada satu waktu, diulang
 * banyak kali untuk dapat distribusi (p50/p90/p99) yang stabil.
 *
 * Output di akhir run k6 (`http_req_duration` per Trend custom di
 * bawah, per endpoint) — SIMPAN angkanya (mis. copy ke
 * `performance-tests/baseline.json` manual, atau paste ke PR
 * description) sebagai baseline pembanding sebelum melakukan
 * perubahan besar (migrasi database, upgrade dependency besar, dst).
 * Metodologi "simpan lalu bandingkan manual", bukan otomatis — CI
 * yang gagal otomatis berdasarkan regresi kecil (mis. dari noise
 * infrastruktur CI runner) lebih sering menghasilkan false positive
 * yang mengajarkan orang mengabaikan gate ini, daripada nilai
 * nyata; perbandingan manual oleh manusia tetap lebih bisa
 * mempertimbangkan konteks (mis. "endpoint ini lambat KARENA fitur
 * baru yang memang lebih berat, bukan regresi tak disengaja").
 *
 * Jalankan: k6 run performance-tests/benchmark.js
 */
const healthDuration = new Trend('benchmark_health_ms', true);
const readyDuration = new Trend('benchmark_ready_ms', true);
const eventsListDuration = new Trend('benchmark_events_list_ms', true);

export const options = {
  vus: 1,
  iterations: 50, // 50 sampel per endpoint — cukup untuk p90/p99 yang tidak terlalu goyang oleh satu outlier, tanpa run yang lama-lama amat.
  thresholds: {
    // TIDAK ada threshold pass/fail di sini — SENGAJA (lihat
    // rationale metodologi di atas). k6 tetap butuh minimal satu key
    // di `thresholds` supaya ringkasan akhir menyorot metrik ini,
    // tapi kondisinya sengaja selalu true (`count>=0`) — murni untuk
    // tampilan laporan, bukan gate.
    benchmark_health_ms: ['count>=0'],
  },
};

export default function benchmark() {
  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'health 200': (r) => r.status === 200 });
  healthDuration.add(health.timings.duration);

  const ready = http.get(`${BASE_URL}/ready`);
  check(ready, { 'ready 200 atau 503 (tetap direspons, bukan timeout)': (r) => r.status === 200 || r.status === 503 });
  readyDuration.add(ready.timings.duration);

  const events = http.get(`${BASE_URL}/api/v1/events?page=1&limit=20`);
  eventsListDuration.add(events.timings.duration);
}
