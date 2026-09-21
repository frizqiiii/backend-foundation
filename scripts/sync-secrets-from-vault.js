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

/**
 * Temuan T17 — nama key dari Vault harus nama variabel environment yang aman. Sebelumnya key dituliskan
 * apa adanya: key berisi newline menyuntikkan baris `.env` baru (terbukti: key `FOO\nNODE_ENV` menghasilkan
 * baris `NODE_ENV="production"` yang dibaca `dotenv`), dan key berisi `=` merusak baris.
 */
function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/**
 * Temuan T17 — meng-encode nilai ke format `.env` yang dibaca IDENTIK oleh dua parser yang dipakai repo ini:
 * `dotenv` v16 (aplikasi, `import 'dotenv/config'`) dan `env_file` Docker Compose.
 *
 * Kenapa bukan `JSON.stringify` seperti sebelumnya: `dotenv` v16 HANYA mengekspansi `\n` dan `\r` di dalam
 * tanda kutip ganda; `\"` dan `\\` TIDAK di-unescape. Nilai `pa"ss` ditulis `"pa\"ss"` dan terbaca
 * `pa\"ss` (BERBEDA dari yang ada di Vault); `a\b` terbaca `a\\b`. Terbukti dengan script asli + `node-vault`
 * asli + `dotenv` v16: 2 dari 10 nilai uji berubah, tanpa error apa pun saat sync. (Compose juga menginterpolasi
 * `$VAR` di dalam tanda kutip ganda, jadi `pa$word` rawan rusak di sana.)
 *
 * Aturan: tanda kutip TUNGGAL = literal murni di kedua parser (tanpa escape, tanpa interpolasi, boleh berisi
 * newline). Kalau nilai memuat `'`, dipakai kutip ganda HANYA jika nilainya tidak butuh escape/interpolasi
 * (tanpa `"`, `\`, `$`, newline). Selain itu mengembalikan `null`: tidak ada encoding yang benar di kedua
 * parser, jadi pemanggil menolak (fail-closed) daripada menulis nilai yang salah diam-diam.
 */
function encodeDotenvValue(value) {
  const v = String(value);
  if (!v.includes("'")) {
    return `'${v}'`;
  }
  if (!/["\\$\r\n]/.test(v)) {
    return `"${v}"`;
  }
  return null;
}

/** Tulis atomik dengan izin 0600: file sementara di direktori yang sama lalu `rename` (tidak pernah setengah tertulis). */
function writeEnvFileAtomically(envFile, content) {
  const tmpFile = `${envFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpFile, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpFile, envFile);
  } catch (err) {
    try {
      fs.unlinkSync(tmpFile);
    } catch (cleanupErr) {
      // file sementara mungkin memang belum dibuat — abaikan
    }
    throw err;
  }
}

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

  try {
    const { protocol, hostname } = new URL(vaultAddr);
    if (protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      console.warn(
        `PERINGATAN: VAULT_ADDR memakai http:// ke host non-lokal (${hostname}) — VAULT_TOKEN dan secret terkirim TANPA enkripsi. Gunakan https://.`
      );
    }
  } catch (err) {
    // VAULT_ADDR bukan URL valid — biarkan node-vault yang melaporkan kegagalannya di bawah.
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

  // Temuan T17 — validasi SEBELUM menyentuh .env: nama key tidak valid, atau nilai yang tidak bisa di-encode
  // dengan benar, menghentikan sync (fail-closed) — bukan menulis .env yang salah diam-diam.
  const invalidKeys = keys.filter((key) => !isValidEnvKey(key));
  if (invalidKeys.length > 0) {
    console.error(
      `Secret di path '${secretPath}' memuat nama key yang tidak valid sebagai variabel environment: ` +
        `${invalidKeys.map((key) => JSON.stringify(key)).join(', ')}. .env TIDAK diubah sama sekali.`
    );
    process.exitCode = 1;
    return;
  }
  const encoded = {};
  const unencodable = [];
  for (const key of keys) {
    const value = encodeDotenvValue(secretData[key]);
    if (value === null) {
      unencodable.push(key);
    } else {
      encoded[key] = value;
    }
  }
  if (unencodable.length > 0) {
    console.error(
      `Nilai untuk key ${unencodable.join(', ')} memuat kombinasi karakter (kutip tunggal bersama kutip ganda, ` +
        `backslash, $, atau newline) yang tidak bisa ditulis ke .env dengan benar untuk dotenv DAN Docker Compose ` +
        `sekaligus. .env TIDAK diubah sama sekali. Ubah nilainya, atau pakai mekanisme secret lain untuk key ini.`
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
      return `${match[1]}=${encoded[match[1]]}`;
    }
    return line;
  });

  for (const key of keys) {
    if (!updatedKeys.has(key)) {
      mergedLines.push(`${key}=${encoded[key]}`);
    }
  }

  // Hapus baris kosong berlebih di akhir sebelum ditulis ulang.
  while (mergedLines.length > 0 && mergedLines[mergedLines.length - 1] === '') {
    mergedLines.pop();
  }

  writeEnvFileAtomically(envFile, mergedLines.join('\n') + '\n');
  console.log(
    `${keys.length} secret dari Vault (path: ${secretPath}) berhasil disinkronkan ke ${envFile}: ${keys.join(', ')}`
  );
}

module.exports = { isValidEnvKey, encodeDotenvValue };

if (require.main === module) {
  main().catch((err) => {
    console.error('Kegagalan tak terduga saat sync secret dari Vault:', err);
    process.exitCode = 1;
  });
}
