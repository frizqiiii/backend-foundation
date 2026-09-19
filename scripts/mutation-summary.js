#!/usr/bin/env node
'use strict';

/**
 * Fase 3 (item 3.5) — ringkasan hasil Stryker dalam Markdown, untuk
 * `$GITHUB_STEP_SUMMARY` di workflow `mutation.yml`.
 *
 * Membaca `reports/mutation/mutation.json` (reporter `json` di
 * `stryker.conf.json`) dan mencetak: skor total, jumlah per status,
 * dan tabel per file (yang paling banyak `Survived` di atas) supaya
 * hasil run mingguan bisa dibaca tanpa mengunduh laporan HTML.
 *
 * Rumus skor SAMA dengan Stryker: (Killed + Timeout) / (Killed +
 * Timeout + Survived + NoCoverage). `CompileError`/`RuntimeError`/
 * `Ignored` TIDAK ikut dihitung (Stryker melaporkannya sebagai
 * `# errors`/ignored, di luar skor). Sudah dicocokkan dengan hasil
 * run penuh nyata: 380 killed + 36 survived -> 91.35%.
 *
 * Nol dependency (hanya `fs`/`path` bawaan Node) — sengaja, supaya
 * langkah ringkasan tidak bisa gagal karena package yang rapuh.
 * Tidak pernah membuat workflow gagal sendiri: kalau laporan tidak
 * ada, mencetak catatan dan keluar dengan kode 0 (kegagalan Stryker
 * yang sebenarnya sudah ditandai oleh langkah `stryker run`).
 */

const fs = require('fs');
const path = require('path');

const reportPath = process.argv[2] || path.join('reports', 'mutation', 'mutation.json');

function emptyCounts() {
  return {
    Killed: 0,
    Timeout: 0,
    Survived: 0,
    NoCoverage: 0,
    CompileError: 0,
    RuntimeError: 0,
    Ignored: 0,
    Pending: 0,
  };
}

function score(c) {
  const detected = c.Killed + c.Timeout;
  const total = detected + c.Survived + c.NoCoverage;
  return total === 0 ? null : (detected / total) * 100;
}

function fmt(value) {
  return value === null ? 'n/a' : value.toFixed(2) + '%';
}

if (!fs.existsSync(reportPath)) {
  console.log('## Mutation testing');
  console.log('');
  console.log(
    `Laporan \`${reportPath}\` tidak ditemukan — Stryker kemungkinan gagal sebelum menulis laporan. Lihat log langkah "Stryker".`
  );
  process.exit(0);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const total = emptyCounts();
const rows = [];

for (const [file, data] of Object.entries(report.files || {})) {
  const counts = emptyCounts();
  for (const mutant of data.mutants || []) {
    if (Object.prototype.hasOwnProperty.call(counts, mutant.status)) {
      counts[mutant.status] += 1;
      total[mutant.status] += 1;
    }
  }
  rows.push({ file, counts });
}

// Yang paling banyak survived di atas; sama-sama nol -> urut nama.
rows.sort((a, b) => b.counts.Survived - a.counts.Survived || a.file.localeCompare(b.file));

const errors = total.CompileError + total.RuntimeError;
const thresholds = report.thresholds || {};

console.log('## Mutation testing');
console.log('');
console.log(`**Skor: ${fmt(score(total))}**` + (thresholds.break != null ? ` (batas gagal: ${thresholds.break}%)` : ''));
console.log('');
console.log(
  `Killed ${total.Killed} · Timeout ${total.Timeout} · **Survived ${total.Survived}** · NoCoverage ${total.NoCoverage} · Errors ${errors} (di luar skor)`
);
console.log('');
console.log('| File | Skor | Killed | Timeout | Survived | NoCov | Errors |');
console.log('|---|---:|---:|---:|---:|---:|---:|');
for (const { file, counts } of rows) {
  const rowErrors = counts.CompileError + counts.RuntimeError;
  console.log(
    `| \`${file}\` | ${fmt(score(counts))} | ${counts.Killed} | ${counts.Timeout} | ${counts.Survived} | ${counts.NoCoverage} | ${rowErrors} |`
  );
}
console.log('');
console.log(
  'Laporan HTML lengkap ada di artifact `mutation-report` (buka `mutation.html`, filter "Survived").'
);
