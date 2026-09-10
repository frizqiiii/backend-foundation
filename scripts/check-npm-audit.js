#!/usr/bin/env node
/**
 * Pengganti `npm audit --audit-level=high` polos di CI.
 *
 * ALASAN file ini ada: `npm audit` menandai SELURUH rentang versi
 * sebuah paket sebagai rentan begitu SATU advisory berlaku untuk
 * PAKET ITU SECARA UMUM -- bukan untuk fitur spesifik yang benar-benar
 * dipakai aplikasi ini. Contoh nyata: GHSA-q7rr-3cgh-j5r3 (lihat
 * `npm-audit-allowlist.json`) hanya relevan untuk built-in HTTP server
 * `@opentelemetry/exporter-prometheus`, paket yang TIDAK PERNAH
 * diimpor di project ini sama sekali -- tapi tetap membuat
 * `npm audit --audit-level=high` gagal karena flag itu ditempel ke
 * `@opentelemetry/sdk-node` (dependency langsung).
 *
 * Daripada memaksakan fix upstream yang justru men-triggers breaking
 * change tidak terkait (lihat alasan lengkap di allowlist), advisory
 * yang SUDAH dianalisis dan dikonfirmasi tidak eksploitatif di
 * aplikasi ini didaftarkan secara eksplisit dengan justifikasi
 * teknis + tanggal review, BUKAN diam-diam di-skip. Kerentanan
 * HIGH/CRITICAL apa pun yang BUKAN di daftar ini tetap menggagalkan
 * build seperti sebelumnya -- script ini mempersempit gate, bukan
 * melonggarkannya secara umum.
 */

const { execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ALLOWLIST_PATH = path.join(__dirname, 'npm-audit-allowlist.json');

function loadAllowlist() {
  const raw = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
  return JSON.parse(raw);
}

function ghsaIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/GHSA-[a-z0-9-]+/i);
  return match ? match[0] : null;
}

function sleepSync(ms) {
  // Blocking sleep TANPA dependency tambahan -- cukup untuk delay
  // singkat antar retry di script CLI sekali-jalan seperti ini
  // (bukan pola yang layak dipakai di kode aplikasi/request path).
  const { execFileSync } = require('node:child_process');
  execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);
}

/**
 * `npm audit --json` diamati LANGSUNG hang/gagal berulang saat
 * menyusun script ini -- npm sendiri menampilkan notice endpoint
 * audit "quick" sedang di-retire, dan responsnya kadang 400/kadang
 * menggantung tanpa batas. Retry dengan backoff pendek di sini murni
 * mitigasi terhadap flakiness REGISTRY itu -- BUKAN untuk menutupi
 * kegagalan lain. Kalau semua percobaan tetap gagal, fungsi ini
 * mengembalikan `null` dan caller WAJIB menggagalkan build (lihat
 * pemanggilnya) -- tidak pernah diam-diam dianggap "bersih".
 */
function runNpmAuditWithRetry(maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return execSync('npm audit --json', {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 20,
        timeout: 60_000,
      });
    } catch (error) {
      if (error.stdout && error.stdout.trim().length > 0) {
        // `npm audit` keluar non-zero justru KETIKA ada temuan
        // (perilaku normal, bukan kegagalan registry) -- stdout tetap
        // berisi JSON yang valid dan itulah yang kita perlukan,
        // TIDAK perlu retry.
        return error.stdout;
      }
      const isLastAttempt = attempt === maxAttempts;
      console.warn(
        `[npm-audit] Percobaan ${attempt}/${maxAttempts} gagal (${error.signal === 'SIGTERM' || error.killed ? 'timeout' : 'registry error'})${isLastAttempt ? '' : ', mencoba lagi...'}`
      );
      if (!isLastAttempt) {
        sleepSync(5000);
      }
    }
  }

  console.error(
    '[npm-audit] `npm audit --json` gagal setelah beberapa percobaan (kemungkinan endpoint registry npm sedang bermasalah -- npm sendiri sudah memberi notice endpoint ini sedang di-retire). Build digagalkan, BUKAN dianggap bersih, supaya kegagalan registry tidak pernah ke-mask jadi "lulus audit".'
  );
  process.exit(1);
}

function main() {
  const allowlist = loadAllowlist();
  const allowlistIds = new Set(allowlist.map((entry) => entry.id));

  // Peringatan (TIDAK menggagalkan build) untuk entri allowlist yang
  // sudah lewat tanggal review -- pengingat supaya risk acceptance
  // ini tidak dibiarkan berlaku selamanya tanpa ditinjau ulang.
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of allowlist) {
    if (entry.reviewBy && entry.reviewBy < today) {
      console.warn(
        `[npm-audit] PERINGATAN: entri allowlist "${entry.id}" (${entry.package}) sudah melewati tanggal review (${entry.reviewBy}). Tinjau ulang apakah masih valid.`
      );
    }
  }

  const auditOutput = runNpmAuditWithRetry();

  let report;
  try {
    report = JSON.parse(auditOutput);
  } catch {
    console.error(
      '[npm-audit] Output `npm audit --json` tidak valid/tidak lengkap (kemungkinan error dari registry, mis. "audit endpoint returned an error"). Build digagalkan -- BUKAN dianggap bersih, supaya kegagalan registry tidak pernah ke-mask jadi "lulus audit".'
    );
    process.exit(1);
  }

  // Sanity check struktur laporan -- laporan yang valid SELALU punya
  // `metadata.vulnerabilities` (boleh berisi nol temuan, itu sah;
  // yang TIDAK sah adalah key ini hilang sama sekali, tanda respons
  // registry-nya bukan laporan audit yang sesungguhnya).
  if (!report || typeof report !== 'object' || !report.metadata?.vulnerabilities) {
    console.error(
      '[npm-audit] Struktur laporan `npm audit --json` tidak seperti yang diharapkan -- build digagalkan, bukan diloloskan diam-diam.'
    );
    process.exit(1);
  }

  const vulnerabilities = report.vulnerabilities ?? {};

  const highOrCriticalPackages = [];
  const advisoryToPackages = new Map(); // GHSA id -> Set(packageName)

  for (const [packageName, info] of Object.entries(vulnerabilities)) {
    if (info.severity !== 'high' && info.severity !== 'critical') {
      continue;
    }
    highOrCriticalPackages.push(packageName);

    const ghsaIds = (info.via ?? [])
      .filter((v) => typeof v === 'object' && v.url)
      .map((v) => ghsaIdFromUrl(v.url))
      .filter(Boolean);

    for (const id of ghsaIds) {
      if (!advisoryToPackages.has(id)) advisoryToPackages.set(id, new Set());
      advisoryToPackages.get(id).add(packageName);
    }
  }

  // Evaluasi di level ADVISORY (GHSA id), BUKAN per-paket. Alasan:
  // paket seperti `@opentelemetry/sdk-trace-node` bisa ditandai HIGH
  // murni karena MEWARISI severity dari paket lain yang jadi
  // dependency-nya (mis. `propagator-jaeger`) — `via`-nya sendiri
  // cuma berisi nama paket lain (string), TANPA advisory object
  // langsung apa pun. Kalau dicek per-paket, paket seperti ini akan
  // SELALU keblokir (tidak pernah punya GHSA id sendiri untuk
  // dicocokkan ke allowlist) walau akar masalahnya sudah tercakup.
  const allGhsaIds = new Set(advisoryToPackages.keys());
  const unreviewedIds = [...allGhsaIds].filter((id) => !allowlistIds.has(id));

  if (allGhsaIds.size > 0) {
    console.log('[npm-audit] Advisory HIGH/CRITICAL yang terdeteksi:');
    for (const id of allGhsaIds) {
      const status = allowlistIds.has(id) ? 'DITERIMA (lihat allowlist)' : 'BELUM DITINJAU';
      console.log(`  - ${id} [${status}] -> ${[...advisoryToPackages.get(id)].join(', ')}`);
    }
  }

  // Paket yang severity-nya HIGH/CRITICAL tapi TIDAK punya GHSA id
  // langsung sama sekali (murni warisan dari paket lain) — hanya
  // diblokir kalau ADA advisory yang belum ditinjau di seluruh
  // laporan; kalau semua advisory root sudah diterima, warisannya
  // ikut dianggap selesai juga.
  const packagesWithNoDirectAdvisory = highOrCriticalPackages.filter(
    (name) => ![...advisoryToPackages.values()].some((set) => set.has(name))
  );
  if (packagesWithNoDirectAdvisory.length > 0) {
    console.log(
      `[npm-audit] Paket HIGH/CRITICAL tanpa advisory langsung (severity murni warisan): ${packagesWithNoDirectAdvisory.join(', ')}`
    );
  }

  if (unreviewedIds.length > 0) {
    console.error(
      '\n[npm-audit] Ada advisory HIGH/CRITICAL yang BELUM ditinjau/diterima -- build digagalkan:'
    );
    for (const id of unreviewedIds) {
      console.error(`  - ${id} -> ${[...advisoryToPackages.get(id)].join(', ')}`);
    }
    console.error(
      '\nKalau temuan ini SUDAH dianalisis dan dipastikan tidak eksploitatif di aplikasi ini, tambahkan ke scripts/npm-audit-allowlist.json DENGAN justifikasi teknis yang jelas -- jangan hanya menambahkan ID tanpa alasan.'
    );
    process.exit(1);
  }

  console.log('\n[npm-audit] Tidak ada advisory HIGH/CRITICAL baru yang belum ditinjau.');
}

main();
