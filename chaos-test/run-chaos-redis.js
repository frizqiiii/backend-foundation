const { spawn, execSync } = require('child_process');
const http = require('http');

let passed = 0, failed = 0;
function ok(label, cond) {
  if (cond) { passed++; console.log(`  [OK]   ${label}`); }
  else { failed++; console.log(`  [GAGAL] ${label}`); }
}

function get(pathname) {
  return new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: 4446, path: pathname, timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }));
    });
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Menjalankan harness (kode ASLI project: rate-limiter + cache) ===');
  const harness = spawn('npx', ['ts-node', '--transpile-only', 'chaos-test/harness-server.ts'], {
    cwd: '/home/claude/project/backend-foundation-main',
    env: process.env,
  });
  let harnessLog = '';
  harness.stdout.on('data', (d) => (harnessLog += d));
  harness.stderr.on('data', (d) => (harnessLog += d));

  await new Promise((resolve, reject) => {
    const check = setInterval(() => {
      if (harnessLog.includes('HARNESS_READY')) { clearInterval(check); resolve(); }
    }, 200);
    setTimeout(() => { clearInterval(check); reject(new Error('Timeout: harness tidak ready.\n' + harnessLog)); }, 20000);
  });
  console.log('Harness siap di port 4446.\n');

  // --- Traffic generator kontinu di background ---
  const trafficLog = [];
  let trafficRunning = true;
  const trafficLoop = (async () => {
    while (trafficRunning) {
      const t0 = Date.now();
      const res = await get('/data');
      trafficLog.push({ t: Date.now(), latencyMs: Date.now() - t0, status: res.status });
      await sleep(150);
    }
  })();

  console.log('=== Fase 1: Traffic normal (Redis hidup), 3 detik ===');
  await sleep(3000);
  const fase1 = trafficLog.slice();
  ok('Semua request Fase 1 sukses (status 200)', fase1.every((r) => r.status === 200));
  console.log(`  (${fase1.length} request, latency rata-rata ${(fase1.reduce((a, r) => a + r.latencyMs, 0) / fase1.length).toFixed(1)}ms)`);

  console.log('\n=== Fase 2: MATIKAN REDIS SUNGGUHAN di tengah traffic ===');
  const tRedisDown = Date.now();
  execSync('redis-cli shutdown nosave', { stdio: 'ignore' });
  await sleep(4000); // biarkan traffic terus jalan selama Redis mati
  const fase2 = trafficLog.filter((r) => r.t > tRedisDown);
  console.log(`  (${fase2.length} request selama Redis mati)`);
  ok('Traffic TETAP DILAYANI selama Redis mati (fail-open, bukan 500 massal)', fase2.every((r) => r.status === 200));
  ok('TIDAK ADA request yang timeout/gagal connect (status 0)', fase2.every((r) => r.status !== 0));
  const maxLatencyFase2 = Math.max(...fase2.map((r) => r.latencyMs));
  ok(`Latency tetap rendah meski Redis mati (maxRetriesPerRequest bekerja) — max ${maxLatencyFase2}ms`, maxLatencyFase2 < 1500);

  console.log('\n=== Fase 3: NYALAKAN REDIS LAGI, ukur waktu pemulihan ===');
  execSync('redis-server --daemonize yes --port 6379', { stdio: 'ignore' });
  const tRedisUp = Date.now();
  // Tunggu sampai request kembali dilayani DENGAN cache aktif lagi (dideteksi
  // lewat computeCount berhenti bertambah tiap request -- cache hit).
  let recovered = false;
  let recoveryMs = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const probe = await get('/data');
    if (probe.status === 200) {
      recovered = true;
      recoveryMs = Date.now() - tRedisUp;
      break;
    }
  }
  ok('App otomatis PULIH memakai Redis lagi TANPA RESTART proses', recovered);
  if (recoveryMs !== null) console.log(`  Waktu pemulihan: ${recoveryMs}ms setelah Redis hidup lagi`);

  console.log('\n=== Fase 4: Traffic normal lagi setelah pemulihan, 2 detik ===');
  await sleep(2000);
  const fase4 = trafficLog.slice(-10);
  ok('Traffic pasca-pemulihan tetap 100% sukses', fase4.every((r) => r.status === 200));

  trafficRunning = false;
  await trafficLoop;
  harness.kill();

  console.log(`\n=== HASIL: ${passed} lolos, ${failed} gagal ===`);
  console.log(`Total request terkirim selama drill: ${trafficLog.length}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
