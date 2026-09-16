// Chaos Engineering (2.7) — HARNESS Express MINIMAL yang memakai KODE
// ASLI project ini (createRateLimiter, getOrSetCache, redisClient) —
// BUKAN tiruan/mock — untuk menguji perilaku fail-open Redis di
// bawah traffic HTTP sungguhan, sambil Redis benar-benar
// dimatikan/dinyalakan di tengah jalan. Tidak menyentuh Prisma sama
// sekali (rute di sini pakai fungsi compute in-memory sebagai
// pengganti query database — cukup untuk menguji jalur cache/rate-limit,
// yang memang tidak bergantung ke Prisma).
import express from 'express';
import { createRateLimiter } from '../src/shared/security/rate-limiter';
import { getOrSetCache } from '../src/shared/utils/cache';
import { redisClient } from '../src/shared/config/redis';

let computeCount = 0;
async function expensiveCompute(): Promise<{ value: string; computedAt: number }> {
  computeCount++;
  return { value: 'hasil-mahal', computedAt: Date.now() };
}

const app = express();
app.use(
  createRateLimiter({
    windowMs: 1000,
    max: 1000, // tinggi -- fokus chaos ini BUKAN menguji limit-nya, tapi fail-open-nya
    message: 'Terlalu banyak request',
    keyPrefix: 'chaos-test',
    keyGenerator: () => 'chaos-test-key',
  })
);
app.get('/data', async (_req, res) => {
  try {
    const result = await getOrSetCache('chaos:test:key', 5, expensiveCompute);
    res.json({ ok: true, computeCount, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

const PORT = 4446;
const server = app.listen(PORT, () => {
  console.log(`HARNESS_READY ${PORT}`);
});

process.on('SIGTERM', () => server.close());
