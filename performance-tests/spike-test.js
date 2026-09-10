import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './k6.config.js';

/**
 * Spike Test (Phase 21 — Enterprise Quality) — BEDA dari Stress Test
 * (`stress-test.js`): Stress Test menaikkan beban BERTAHAP untuk
 * mencari batas kapasitas; Spike Test justru menguji seberapa BAIK
 * sistem menangani LONJAKAN MENDADAK (dari beban rendah LANGSUNG ke
 * beban tinggi dalam hitungan DETIK, bukan menit) — skenario dunia
 * nyata seperti flash sale, campaign viral tiba-tiba, atau serangan
 * DDoS singkat. Yang diamati: apakah rate limiter (Phase 18,
 * `shared/security/rate-limiter.ts`) dan HPA (Phase 20,
 * `k8s/hpa.yaml`) merespons cukup cepat, dan apakah sistem PULIH
 * bersih begitu lonjakan reda (bukan tetap error terus meski beban
 * sudah turun — indikasi resource yang tidak dilepas dengan benar).
 *
 * Jalankan: k6 run performance-tests/spike-test.js
 */
export const options = {
  stages: [
    { duration: '30s', target: 10 }, // baseline tenang
    { duration: '10s', target: 400 }, // LONJAKAN MENDADAK — dari 10 ke 400 VU dalam 10 detik (BUKAN bertahap seperti stress test)
    { duration: '1m', target: 400 }, // tahan di puncak — amati apakah sistem stabil atau terus memburuk
    { duration: '10s', target: 10 }, // turun MENDADAK juga — amati kecepatan pemulihan
    { duration: '30s', target: 10 }, // baseline lagi — error rate/latency SEHARUSNYA kembali ke level awal di sini; kalau tidak, itu sinyal resource leak
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'],
  },
};

export default function spikeTest() {
  const response = http.get(`${BASE_URL}/health`);
  check(response, { 'menerima response (status apa pun < 500 dianggap "hidup")': (r) => r.status < 500 });
  sleep(0.1);
}
