import fs from 'fs';
import path from 'path';

/**
 * Temuan T10/T12 — penjaga: SETIAP action pihak ketiga di workflow harus di-pin ke SHA commit
 * penuh (40 hex), bukan tag atau branch.
 *
 * Kenapa tag/branch tidak cukup: pada 2026-03-19 tag `aquasecurity/trivy-action` (76 dari 77)
 * di-force-push ke malware pencuri kredensial. Tag dan branch adalah pointer yang bisa
 * dipindahkan oleh siapa pun yang menguasai akun pemiliknya; SHA tidak bisa. Job `docker-build-and-scan`
 * berjalan dengan `packages: write` + `id-token: write`, dan `deploy.yml` memegang secret SSH VPS —
 * action yang jahat di sana mendapat akses itu.
 *
 * Test ini mencegah kemunduran (mis. seseorang menambah `uses: foo/bar@main`) di PR, bukan setelah
 * merge. Untuk memperbarui pin secara sah, biarkan Dependabot (`.github/dependabot.yml`) membuka PR-nya.
 *
 * Dikecualikan: action lokal (`./...`) dan image Docker (`docker://...`).
 */
const WORKFLOWS_DIR = path.resolve(__dirname, '../../../.github/workflows');
const FULL_SHA = /^[0-9a-f]{40}$/;

interface UsesRef {
  file: string;
  line: number;
  ref: string;
}

function collectUses(): UsesRef[] {
  const refs: UsesRef[] = [];
  for (const file of fs.readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name))) {
    fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8')
      .split(/\r?\n/)
      .forEach((text, index) => {
        const match = /^\s*(?:-\s+)?uses:\s*(\S+)/.exec(text);
        if (match) {
          refs.push({ file, line: index + 1, ref: match[1].replace(/^['"]|['"]$/g, '') });
        }
      });
  }
  return refs;
}

describe('Workflow GitHub Actions — pin SHA (temuan T10/T12)', () => {
  const refs = collectUses();
  const thirdParty = refs.filter(
    ({ ref }) => !ref.startsWith('./') && !ref.startsWith('docker://')
  );

  it('pemindai menemukan referensi `uses:` (bukan lolos karena tidak menemukan apa-apa)', () => {
    expect(thirdParty.length).toBeGreaterThan(10);
  });

  it('SETIAP `uses:` memakai SHA commit penuh 40 hex, bukan tag/branch', () => {
    const unpinned = thirdParty
      .filter(({ ref }) => !FULL_SHA.test(ref.split('@')[1] ?? ''))
      .map(({ file, line, ref }) => `.github/workflows/${file}:${line}  ${ref}`);

    expect(unpinned).toEqual([]);
  });
});
