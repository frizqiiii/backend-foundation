import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import dotenv from 'dotenv';

/**
 * Temuan T17 — `scripts/sync-secrets-from-vault.js` (item 2.4), dijalankan SUNGGUHAN: script asli sebagai proses
 * anak, klien `node-vault` asli, server HTTP tiruan yang meniru format KV v2 Vault, dan hasilnya dibaca ulang dengan
 * `dotenv` v16 (parser yang dipakai aplikasi). Batas jujur: ini BUKAN Vault sungguhan (lihat
 * `docs/secrets-management.md`), dan parser `env_file` Docker Compose tidak ikut diuji (tidak ada Docker di sini).
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encodeDotenvValue, isValidEnvKey } = require(
  path.resolve(__dirname, '../../../scripts/sync-secrets-from-vault.js')
) as {
  encodeDotenvValue: (value: string) => string | null;
  isValidEnvKey: (key: string) => boolean;
};

const SCRIPT = path.resolve(__dirname, '../../../scripts/sync-secrets-from-vault.js');

jest.setTimeout(60_000);

/** Nilai yang sebelum T17 rusak (`"` dan `\`) maupun yang memang aman, semuanya harus terbaca IDENTIK. */
const ROUND_TRIP_VALUES: Record<string, string> = {
  SIMPLE: 'abc123',
  WITH_DOUBLE_QUOTE: 'pa"ss',
  WITH_BACKSLASH: 'a\\b',
  WITH_BACKSLASH_N_LITERAL: 'C:\\temp\\new',
  WITH_DOLLAR: 'pa$word',
  WITH_DOLLAR_BRACES: 'x${HOME}y',
  WITH_HASH: 'abc#def',
  WITH_SPACES: '  spasi di tepi  ',
  WITH_NEWLINE: 'baris1\nbaris2',
  WITH_EQUALS: 'a=b=c',
  UNICODE: 'paßwörd✓',
  WITH_SINGLE_QUOTE: "it's",
  BASE64: 'abc+/==',
  EMPTY: '',
};

interface VaultMock {
  url: string;
  setPayload: (payload: Record<string, unknown> | null) => void;
  close: () => Promise<void>;
}

async function startVaultMock(token: string): Promise<VaultMock> {
  let payload: Record<string, unknown> | null = {};
  const server = http.createServer((req, res) => {
    if (req.headers['x-vault-token'] !== token) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"errors":["permission denied"]}');
      return;
    }
    if (payload === null) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"errors":[]}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: payload, metadata: {} } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    setPayload: (next) => {
      payload = next;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScript(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT],
      { env: { ...process.env, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

describe('encodeDotenvValue / isValidEnvKey (temuan T17)', () => {
  it.each(Object.entries(ROUND_TRIP_VALUES))(
    '%s: hasil encode terbaca IDENTIK oleh dotenv v16',
    (key, value) => {
      const encoded = encodeDotenvValue(value);
      expect(encoded).not.toBeNull();

      expect(dotenv.parse(`${key}=${encoded}\n`)[key]).toBe(value);
    }
  );

  it("kutip tunggal dipakai bila nilai tidak memuat `'` (literal murni: tanpa escape dan tanpa interpolasi)", () => {
    expect(encodeDotenvValue('pa"ss')).toBe(`'pa"ss'`);
    expect(encodeDotenvValue('a\\b')).toBe(`'a\\b'`);
    expect(encodeDotenvValue('pa$word')).toBe(`'pa$word'`);
  });

  it("nilai dengan `'` memakai kutip ganda HANYA kalau tidak butuh escape/interpolasi", () => {
    expect(encodeDotenvValue("it's")).toBe(`"it's"`);
  });

  it.each([`it's "x"`, `it's a\\b`, `it's $HOME`, `it's\nbaris`])(
    "nilai %j memuat `'` DAN karakter yang butuh escape/interpolasi -> null (ditolak, bukan ditulis salah)",
    (value) => {
      expect(encodeDotenvValue(value)).toBeNull();
    }
  );

  it('isValidEnvKey menerima nama variabel wajar dan menolak newline, "=", spasi, tanda hubung, angka di depan, kosong', () => {
    for (const ok of ['DATABASE_URL', 'jwt_secret', '_X', 'A1']) {
      expect(isValidEnvKey(ok)).toBe(true);
    }
    for (const bad of ['FOO\nNODE_ENV', 'A=B', 'A B', 'A-B', '1A', '', 'A.B']) {
      expect(isValidEnvKey(bad)).toBe(false);
    }
  });
});

describe('scripts/sync-secrets-from-vault.js — dijalankan sungguhan (temuan T17)', () => {
  let vault: VaultMock;
  let dir: string;
  let envFile: string;

  const env = (): Record<string, string> => ({
    VAULT_ADDR: vault.url,
    VAULT_TOKEN: 'token-uji',
    SYNC_ENV_FILE: envFile,
  });

  beforeAll(async () => {
    vault = await startVaultMock('token-uji');
  });

  afterAll(async () => {
    await vault.close();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-secrets-'));
    envFile = path.join(dir, '.env');
    vault.setPayload({});
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sync sukses: baris .env yang sudah ada dipertahankan, secret Vault ditambahkan', async () => {
    fs.writeFileSync(envFile, 'PORT=3000\nNODE_ENV=production\n');
    vault.setPayload({ JWT_SECRET: 'rahasia', DATABASE_URL: 'postgresql://u:p@db/app' });

    const result = await runScript(env());

    expect(result.code).toBe(0);
    const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8'));
    expect(parsed).toEqual({
      PORT: '3000',
      NODE_ENV: 'production',
      JWT_SECRET: 'rahasia',
      DATABASE_URL: 'postgresql://u:p@db/app',
    });
  });

  it('SEMUA nilai uji (termasuk yang mengandung `"` dan `\\`, yang sebelum T17 berubah diam-diam) terbaca identik oleh dotenv', async () => {
    vault.setPayload(ROUND_TRIP_VALUES);

    const result = await runScript(env());

    expect(result.code).toBe(0);
    expect(dotenv.parse(fs.readFileSync(envFile, 'utf8'))).toEqual(ROUND_TRIP_VALUES);
  });

  it('sync kedua menimpa di tempat (idempoten): tidak ada baris ganda', async () => {
    vault.setPayload({ JWT_SECRET: 'v1' });
    await runScript(env());
    vault.setPayload({ JWT_SECRET: 'v2' });

    await runScript(env());

    const content = fs.readFileSync(envFile, 'utf8');
    expect(content.match(/^JWT_SECRET=/gm)).toHaveLength(1);
    expect(dotenv.parse(content).JWT_SECRET).toBe('v2');
  });

  (process.platform === 'win32' ? it.skip : it)(
    'file .env yang dibuat berizin 0600 (bukan 0644 yang bisa dibaca semua user di VPS)',
    async () => {
      vault.setPayload({ JWT_SECRET: 'rahasia' });

      await runScript({ ...env(), UMASK_TIDAK_DIPAKAI: '1' });

      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    }
  );

  (process.platform === 'win32' ? it.skip : it)(
    '.env lama berizin 0644 diganti menjadi 0600 setelah sync',
    async () => {
      fs.writeFileSync(envFile, 'PORT=3000\n', { mode: 0o644 });
      fs.chmodSync(envFile, 0o644);
      vault.setPayload({ JWT_SECRET: 'rahasia' });

      await runScript(env());

      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    }
  );

  it('tidak meninggalkan file sementara setelah sync (penulisan atomik: tulis .tmp lalu rename)', async () => {
    vault.setPayload({ JWT_SECRET: 'rahasia' });

    await runScript(env());

    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it('key Vault berisi newline (suntikan baris .env) -> DITOLAK, exit 1, .env TIDAK berubah sama sekali', async () => {
    const original = 'PORT=3000\nNODE_ENV=development\n';
    fs.writeFileSync(envFile, original);
    vault.setPayload({ 'FOO\nNODE_ENV': 'production', OK_KEY: 'x' });

    const result = await runScript(env());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('nama key yang tidak valid');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(original);
  });

  it('nilai yang tidak bisa di-encode benar untuk dotenv DAN Compose -> DITOLAK, exit 1, .env TIDAK berubah', async () => {
    const original = 'PORT=3000\n';
    fs.writeFileSync(envFile, original);
    vault.setPayload({ AMAN: 'ok', SULIT: `it's "x"` });

    const result = await runScript(env());

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('SULIT');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(original);
  });

  it('secret kosong -> exit 1, .env tidak berubah (perilaku fail-closed yang sudah ada tetap)', async () => {
    fs.writeFileSync(envFile, 'PORT=3000\n');
    vault.setPayload({});

    const result = await runScript(env());

    expect(result.code).toBe(1);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('PORT=3000\n');
  });

  it('token salah -> exit 1, .env tidak berubah', async () => {
    fs.writeFileSync(envFile, 'PORT=3000\n');
    vault.setPayload({ JWT_SECRET: 'rahasia' });

    const result = await runScript({ ...env(), VAULT_TOKEN: 'token-salah' });

    expect(result.code).toBe(1);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('PORT=3000\n');
  });

  it('path tidak ada (404) -> exit 1, .env tidak berubah', async () => {
    fs.writeFileSync(envFile, 'PORT=3000\n');
    vault.setPayload(null);

    const result = await runScript(env());

    expect(result.code).toBe(1);
    expect(fs.readFileSync(envFile, 'utf8')).toBe('PORT=3000\n');
  });

  it('VAULT_TOKEN tidak diisi -> ditolak sebelum menghubungi Vault sama sekali', async () => {
    const result = await runScript({ ...env(), VAULT_TOKEN: '' });

    expect(result.code).toBe(1);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('VAULT_ADDR http:// ke host non-lokal memicu PERINGATAN (token terkirim tanpa enkripsi)', async () => {
    const result = await runScript({ ...env(), VAULT_ADDR: 'http://vault.invalid:8200' });

    expect(result.stderr).toContain('PERINGATAN');
    expect(result.stderr).toContain('vault.invalid');
  });

  it('VAULT_ADDR http://127.0.0.1 (lokal/dev) TIDAK memicu peringatan itu', async () => {
    vault.setPayload({ JWT_SECRET: 'rahasia' });

    const result = await runScript(env());

    expect(result.stderr).not.toContain('PERINGATAN');
  });
});
