#!/usr/bin/env node
/**
 * Fase 2 (Kelompok 2 — Secrets Management, item 2.4).
 *
 * Mengambil secret dari HashiCorp Vault (KV v2 engine) dan
 * menuliskannya ke `.env` — dijalankan SEBELUM `npm start`/`node
 * dist/server.js` (lihat integrasi di `deploy/scripts/deploy.sh`),
 * BUKAN dipanggil dari dalam proses aplikasi itu sendiri.
 *
 * KENAPA pola ini (sync-lalu-tulis-file), BUKAN app connect ke Vault
 * langsung saat runtime: `env.ts` men-validasi `process.env` secara
 * SINKRON di titik import pertama (`cleanEnv(...)`, lihat komentar di
 * file itu) — mengubah ini jadi async (nunggu fetch Vault) berarti
 * merombak urutan bootstrap `server.ts`/`worker.ts` yang sudah
 * establish & sensitif (lihat komentar "HARUS jadi import PALING
 * PERTAMA" di `tracing.ts`). Pola sync-ke-file ini yang dipakai
 * banyak deployment Vault sungguhan (mis. Vault Agent, init container
 * Kubernetes) — Vault jadi SUMBER KEBENARAN untuk secret, tapi app
 * itu sendiri tetap baca `process.env` biasa tanpa tahu-menahu soal
 * Vault sama sekali, nol perubahan ke `env.ts`/urutan bootstrap.
 *
 * FAIL-CLOSED (BUKAN fail-open seperti cache/rate-limiter di
 * aplikasi) — SENGAJA: kalau Vault tidak terjangkau/token salah/path
 * tidak ada/secret kosong, script berhenti dengan exit code 1 TANPA
 * menyentuh `.env` sama sekali (bukan menulis file kosong/parsial).
 * Kegagalan sync secret HARUS terlihat jelas & menghentikan deploy,
 * bukan diam-diam lanjut dengan `.env` lama yang mungkin sudah basi
 * atau ter-corrupt.
 */
const fs = require('fs');
const path = require('path');

async function main() {
  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;
  const secretPath = process.env.VAULT_SECRET_PATH || 'secret/data/backend-foundation';
  const envFile = process.env.SYNC_ENV_FILE || path.resolve(process.cwd(), '.env');

  if (!vaultAddr || !vaultToken) {
    console.error(
      'VAULT_ADDR dan VAULT_TOKEN wajib diisi (lewat environment variable) untuk menjalankan script ini.'
    );
    process.exitCode = 1;
    return;
  }

  const vault = require('node-vault')({ endpoint: vaultAddr, token: vaultToken });

  let secretData;
  try {
    const result = await vault.read(secretPath);
    secretData = result.data.data; // KV v2: payload asli ada di data.data (BUKAN data langsung).
  } catch (err) {
    console.error(
      `Gagal mengambil secret dari Vault di path '${secretPath}': ${err.message}. ` +
        `.env TIDAK diubah sama sekali.`
    );
    process.exitCode = 1;
    return;
  }

  const keys = Object.keys(secretData || {});
  if (keys.length === 0) {
    console.error(
      `Secret di path '${secretPath}' kosong — kemungkinan salah path atau belum pernah diisi. ` +
        `.env TIDAK diubah sama sekali.`
    );
    process.exitCode = 1;
    return;
  }

  // Merge dengan .env yang SUDAH ADA — baris yang key-nya TIDAK berasal
  // dari Vault (mis. PORT, NODE_ENV) dipertahankan apa adanya, cuma
  // baris yang key-nya cocok dengan secret Vault yang ditimpa/ditambah.
  let existingLines = [];
  if (fs.existsSync(envFile)) {
    existingLines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  }

  const updatedKeys = new Set();
  const mergedLines = existingLines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match && Object.prototype.hasOwnProperty.call(secretData, match[1])) {
      updatedKeys.add(match[1]);
      return `${match[1]}=${JSON.stringify(String(secretData[match[1]]))}`;
    }
    return line;
  });

  for (const key of keys) {
    if (!updatedKeys.has(key)) {
      mergedLines.push(`${key}=${JSON.stringify(String(secretData[key]))}`);
    }
  }

  // Hapus baris kosong berlebih di akhir sebelum ditulis ulang.
  while (mergedLines.length > 0 && mergedLines[mergedLines.length - 1] === '') {
    mergedLines.pop();
  }

  fs.writeFileSync(envFile, mergedLines.join('\n') + '\n', 'utf8');
  console.log(
    `${keys.length} secret dari Vault (path: ${secretPath}) berhasil disinkronkan ke ${envFile}: ${keys.join(', ')}`
  );
}

main().catch((err) => {
  console.error('Kegagalan tak terduga saat sync secret dari Vault:', err);
  process.exitCode = 1;
});
