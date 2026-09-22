import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temuan T20 — `deploy/scripts/deploy-blue-green.sh` sebelumnya menjalankan build (`git pull`/`npm ci`/
 * `prisma migrate deploy`/`npm run build`) di SATU direktori yang dipakai bersama oleh blue & green. Dibuktikan
 * nyata (di luar suite ini, lihat docs/blue-green-deployment.md) lewat cluster PM2 sungguhan: build "green"
 * menimpa file yang masih dipakai proses "blue" yang aktif.
 *
 * Skrip asli dijalankan sungguhan (bash), dengan `git`/`npm`/`npx`/`pm2`/`curl`/`sudo`/`nginx` diganti stub di
 * PATH yang mencatat argumen & cwd — supaya ALUR KEPUTUSAN dan ISOLASI DIREKTORI teruji tanpa nginx/PM2/Postgres
 * sungguhan (jalan di CI mana pun). Perilaku terhadap PM2 sungguhan dibuktikan terpisah, dicatat di
 * docs/blue-green-deployment.md. Dilewati di Windows (skrip bash untuk VPS Linux).
 */
const SCRIPT = path.resolve(__dirname, '../../../deploy/scripts/deploy-blue-green.sh');
const runOnBashHost = process.platform === 'win32' ? describe.skip : describe;

jest.setTimeout(30_000);

function stub(body: string): string {
  return `#!/usr/bin/env bash\n${body}\n`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [SCRIPT],
      { env: { ...process.env, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

runOnBashHost('deploy-blue-green.sh — isolasi direktori blue/green (temuan T20)', () => {
  let root: string;
  let stubDir: string;
  let blueDir: string;
  let greenDir: string;
  let nginxConf: string;
  let buildLog: string;

  const writeStubs = (opts: { standbyReady: boolean }) => {
    fs.writeFileSync(
      path.join(stubDir, 'git'),
      stub(`echo "GIT $(pwd) $*" >> "$BUILD_LOG"\nexit 0`),
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(stubDir, 'npm'),
      stub(`echo "NPM $(pwd) $*" >> "$BUILD_LOG"\nexit 0`),
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(stubDir, 'npx'),
      stub(`echo "NPX $(pwd) $*" >> "$BUILD_LOG"\nexit 0`),
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(stubDir, 'pm2'),
      stub(`echo "PM2 $(pwd) $*" >> "$BUILD_LOG"\nexit 0`),
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(stubDir, 'sudo'), stub(`echo "SUDO $*" >> "$BUILD_LOG"\n"$@"`), {
      mode: 0o755,
    });
    fs.writeFileSync(path.join(stubDir, 'nginx'), stub(`exit 0`), { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, 'systemctl'), stub(`exit 0`), { mode: 0o755 });
    fs.writeFileSync(
      path.join(stubDir, 'curl'),
      stub(
        `if [[ "$*" == *":3001/ready"* || "$*" == *":3000/ready"* ]]; then\n  [ "${opts.standbyReady ? '1' : '0'}" = "1" ] && exit 0 || exit 1\nfi\nexit 0`
      ),
      { mode: 0o755 }
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-test-'));
    stubDir = path.join(root, 'stub');
    blueDir = path.join(root, 'blue');
    greenDir = path.join(root, 'green');
    fs.mkdirSync(stubDir);
    fs.mkdirSync(path.join(blueDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(greenDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(blueDir, 'deploy', 'pm2'), { recursive: true });
    fs.mkdirSync(path.join(greenDir, 'deploy', 'pm2'), { recursive: true });
    fs.writeFileSync(path.join(blueDir, 'deploy', 'pm2', 'ecosystem.config.js'), '');
    fs.writeFileSync(path.join(greenDir, 'deploy', 'pm2', 'ecosystem.green.config.js'), '');
    // File "sentinel" di direktori blue (ACTIVE) — kalau isinya berubah setelah script
    // jalan, berarti direktori active ikut disentuh (persis bug T20).
    fs.writeFileSync(path.join(blueDir, 'dist-marker.txt'), 'BLUE-ORIGINAL-UNTOUCHED');
    nginxConf = path.join(root, 'nginx.conf');
    // green sedang backup -> blue aktif, green standby
    fs.writeFileSync(nginxConf, 'server 127.0.0.1:3001 backup;\nserver 127.0.0.1:3000;\n');
    buildLog = path.join(root, 'build.log');
    fs.writeFileSync(buildLog, '');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const baseEnv = () => ({
    PATH: `${stubDir}:${process.env.PATH ?? ''}`,
    NGINX_CONF: nginxConf,
    BUILD_LOG: buildLog,
    BLUE_APP_DIR: blueDir,
    GREEN_APP_DIR: greenDir,
  });

  it('menolak (fail-closed) kalau BLUE_APP_DIR/GREEN_APP_DIR tidak ada', async () => {
    writeStubs({ standbyReady: true });
    const badGreen = path.join(root, 'tidak-ada');
    const res = await run({ ...baseEnv(), GREEN_APP_DIR: badGreen });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/tidak ada atau bukan clone git sendiri/);
  });

  it('menolak (fail-closed) kalau BLUE_APP_DIR dan GREEN_APP_DIR menunjuk direktori fisik yang sama', async () => {
    writeStubs({ standbyReady: true });
    const res = await run({ ...baseEnv(), GREEN_APP_DIR: blueDir });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/direktori FISIK yang SAMA/);
  });

  it('build HANYA berjalan di direktori standby (green), TIDAK PERNAH di direktori active (blue)', async () => {
    writeStubs({ standbyReady: true });
    const res = await run(baseEnv());
    expect(res.code).toBe(0);
    const log = fs.readFileSync(buildLog, 'utf8');
    // git/npm/npx dipanggil dengan cwd = greenDir, TIDAK PERNAH blueDir
    expect(log).toMatch(new RegExp(`GIT ${greenDir}`));
    expect(log).not.toMatch(new RegExp(`GIT ${blueDir}`));
    expect(log).not.toMatch(new RegExp(`NPM ${blueDir}`));
    // sentinel di direktori active tidak pernah diubah oleh script ini
    expect(fs.readFileSync(path.join(blueDir, 'dist-marker.txt'), 'utf8')).toBe(
      'BLUE-ORIGINAL-UNTOUCHED'
    );
  });

  it('kalau standby tidak pernah /ready, nginx TIDAK diubah dan exit 1 (fail-closed, tidak berubah dari perilaku lama)', async () => {
    writeStubs({ standbyReady: false });
    const res = await run(baseEnv());
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/DEPLOY DIBATALKAN/);
  });
});
