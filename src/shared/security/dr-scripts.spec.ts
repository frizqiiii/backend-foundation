import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temuan T19 — skrip Disaster Recovery (`scripts/backup-db.sh`, `verify-backup.sh`, `restore-db.sh`) di bawah
 * Row-Level Security.
 *
 * Skrip asli dijalankan sungguhan (bash), tetapi `psql`, `pg_dump`, dan `pg_restore` diganti stub di PATH yang
 * mencatat argumen dan lingkungannya, supaya ALUR KEPUTUSAN skrip teruji tanpa Postgres (jalan di CI mana pun).
 * Perilaku terhadap PostgreSQL 16 sungguhan (FORCE RLS, `pg_dump`, `pg_restore --clean`) dibuktikan terpisah dan
 * dicatat di `docs/backup-restore-guide.md`. Dilewati di Windows (skrip bash untuk VPS Linux).
 */
const SCRIPTS = path.resolve(__dirname, '../../../scripts');
const runOnBashHost = process.platform === 'win32' ? describe.skip : describe;

jest.setTimeout(60_000);

const PSQL_STUB = `#!/usr/bin/env bash
echo "PSQL PGOPTIONS=\${PGOPTIONS:-} ARGS=$*" >> "$STUB_LOG_DIR/psql.log"
ARGS="$*"
if [[ "$ARGS" == *rolsuper* ]]; then
  [ "\${STUB_CONNECT_FAIL:-0}" = "1" ] && exit 2
  echo "\${STUB_CAN_BYPASS:-t}"; exit 0
fi
if [[ "$ARGS" == *pg_postmaster_start_time* ]]; then
  [ "\${STUB_PROD_UNREACHABLE:-0}" = "1" ] && [[ "$ARGS" == *proddb* ]] && exit 2
  DB=$(printf '%s' "$ARGS" | sed -E 's#.*--dbname=[^ ]*/([A-Za-z0-9_]+)[ ].*#\\1#')
  echo "$DB|16384|2026-09-21 00:00:00+00"; exit 0
fi
if [[ "$ARGS" == *"COUNT(*)"* ]]; then
  if [ "\${STUB_COUNT_FAIL_UNDER_RLS_OFF:-0}" = "1" ] && [[ "\${PGOPTIONS:-}" == *row_security=off* ]]; then exit 1; fi
  echo "\${STUB_COUNT:-5}"; exit 0
fi
exit 0
`;

const PG_DUMP_STUB = `#!/usr/bin/env bash
echo "PGDUMP ARGS=$*" >> "$STUB_LOG_DIR/pg_dump.log"
while [ $# -gt 0 ]; do
  if [ "$1" = "-f" ]; then OUT="$2"; fi
  shift
done
[ -n "\${OUT:-}" ] && echo "DUMP" > "$OUT"
exit "\${STUB_DUMP_EXIT:-0}"
`;

const PG_RESTORE_STUB = `#!/usr/bin/env bash
echo "PGRESTORE ARGS=$*" >> "$STUB_LOG_DIR/pg_restore.log"
exit 0
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  script: string,
  args: string[],
  env: Record<string, string>,
  stdin?: string
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      [path.join(SCRIPTS, script), ...args],
      { env: { ...process.env, ...env }, timeout: 30_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      }
    );
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

const PROD_URL = 'postgresql://app:rahasia-prod@localhost:5432/proddb';
const BYPASS_URL = 'postgresql://backup:rahasia-bk@localhost:5432/proddb';

runOnBashHost(
  'Skrip DR di bawah RLS — dijalankan sungguhan dengan stub psql/pg_dump/pg_restore (temuan T19)',
  () => {
    let dir: string;
    let stubDir: string;
    let logDir: string;
    let envFile: string;
    let backupDir: string;

    const baseEnv = (): Record<string, string> => ({
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      STUB_LOG_DIR: logDir,
      ENV_FILE: envFile,
      BACKUP_DIR: backupDir,
    });
    const log = (name: string): string => {
      const file = path.join(logDir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-scripts-'));
      stubDir = path.join(dir, 'bin');
      logDir = path.join(dir, 'logs');
      backupDir = path.join(dir, 'backups');
      envFile = path.join(dir, '.env');
      fs.mkdirSync(stubDir);
      fs.mkdirSync(logDir);
      for (const [name, body] of Object.entries({
        psql: PSQL_STUB,
        pg_dump: PG_DUMP_STUB,
        pg_restore: PG_RESTORE_STUB,
      })) {
        fs.writeFileSync(path.join(stubDir, name), body, { mode: 0o755 });
      }
      fs.writeFileSync(envFile, `DATABASE_URL="${PROD_URL}"\n`);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('backup-db.sh', () => {
      it('role backup yang TUNDUK RLS -> ditolak SEBELUM pg_dump dijalankan (bukan backup kosong yang tampak sukses)', async () => {
        const result = await run('backup-db.sh', [], { ...baseEnv(), STUB_CAN_BYPASS: 'f' });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('BYPASSRLS');
        expect(log('pg_dump.log')).toBe('');
        expect(fs.existsSync(backupDir)).toBe(false);
      });

      it('tidak bisa memeriksa hak role (koneksi gagal) -> ditolak dengan pesan yang membedakannya dari "role tunduk RLS"', async () => {
        const result = await run('backup-db.sh', [], { ...baseEnv(), STUB_CONNECT_FAIL: '1' });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('tidak bisa terhubung');
        expect(log('pg_dump.log')).toBe('');
      });

      it('role BYPASSRLS/superuser -> pg_dump jalan; BACKUP_DATABASE_URL dipakai menggantikan DATABASE_URL', async () => {
        const result = await run('backup-db.sh', [], {
          ...baseEnv(),
          BACKUP_DATABASE_URL: BYPASS_URL,
        });

        expect(result.code).toBe(0);
        expect(log('pg_dump.log')).toContain(`--dbname=${BYPASS_URL}`);
        expect(log('pg_dump.log')).not.toContain('rahasia-prod');
      });

      it('tanpa BACKUP_DATABASE_URL memakai DATABASE_URL dari .env (kompatibel mundur)', async () => {
        const result = await run('backup-db.sh', [], baseEnv());

        expect(result.code).toBe(0);
        expect(log('pg_dump.log')).toContain(`--dbname=${PROD_URL}`);
      });

      it('file backup, sidecar .meta, dan direktori berizin 0600/0600/0700 (bukan 0644/0644/0755 yang terbaca semua user)', async () => {
        await run('backup-db.sh', [], baseEnv());

        const files = fs.readdirSync(backupDir);
        const dump = files.find((name) => name.endsWith('.dump')) as string;
        expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(backupDir, dump)).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(backupDir, `${dump}.meta`)).mode & 0o777).toBe(0o600);
      });

      it('sidecar .meta memuat jumlah baris SEMUA tabel kunci (termasuk tabel ber-RLS), dihitung dengan row_security=off', async () => {
        await run('backup-db.sh', [], { ...baseEnv(), STUB_COUNT: '7' });

        const meta = fs.readFileSync(
          path.join(
            backupDir,
            fs.readdirSync(backupDir).find((n) => n.endsWith('.meta')) as string
          ),
          'utf8'
        );
        for (const table of [
          'users',
          'events',
          'products',
          'api_keys',
          'webhook_endpoints',
          'export_jobs',
        ]) {
          expect(meta).toContain(`rowcount_${table}=7`);
        }
        const countCalls = log('psql.log')
          .split('\n')
          .filter((line) => line.includes('COUNT(*)'));
        expect(countCalls).toHaveLength(6);
        expect(countCalls.every((line) => line.includes('row_security=off'))).toBe(true);
      });

      it('pg_dump gagal -> exit 1 dan tidak meninggalkan file dump setengah jadi', async () => {
        const result = await run('backup-db.sh', [], { ...baseEnv(), STUB_DUMP_EXIT: '1' });

        expect(result.code).toBe(1);
        expect(fs.readdirSync(backupDir).filter((name) => name.endsWith('.dump'))).toEqual([]);
      });
    });

    describe('verify-backup.sh', () => {
      let dumpFile: string;

      beforeEach(() => {
        dumpFile = path.join(dir, 'backup_x.dump');
        fs.writeFileSync(dumpFile, 'DUMP');
        fs.writeFileSync(
          `${dumpFile}.meta`,
          ['users', 'events', 'products', 'api_keys', 'webhook_endpoints', 'export_jobs']
            .map((table) => `rowcount_${table}=5`)
            .join('\n') + '\n'
        );
      });

      it('URL verifikasi menunjuk ke database YANG SAMA dengan production lewat ejaan berbeda (127.0.0.1 vs localhost) -> DITOLAK, pg_restore --clean tidak jalan', async () => {
        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          VERIFY_DATABASE_URL: 'postgresql://app:rahasia-prod@127.0.0.1:5432/proddb',
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain('YANG SAMA');
        expect(log('pg_restore.log')).toBe('');
      });

      it('URL identik dengan production (pembanding string lama) tetap ditolak', async () => {
        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          VERIFY_DATABASE_URL: PROD_URL,
        });

        expect(result.code).toBe(1);
        expect(log('pg_restore.log')).toBe('');
      });

      it('database verifikasi yang benar-benar TERPISAH -> restore jalan dan semua tabel [OK]', async () => {
        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          VERIFY_DATABASE_URL: 'postgresql://bk:rahasia-bk@localhost:5432/verifydb',
        });

        expect(result.code).toBe(0);
        expect(log('pg_restore.log')).toContain(
          '--dbname=postgresql://bk:rahasia-bk@localhost:5432/verifydb'
        );
        expect(result.stdout.match(/\[OK\]/g)).toHaveLength(6);
      });

      it('production tidak terjangkau dari mesin ini (verifikasi di host terpisah) -> pemeriksaan identitas dilewati, verifikasi tetap jalan', async () => {
        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          STUB_PROD_UNREACHABLE: '1',
          VERIFY_DATABASE_URL: 'postgresql://bk:rahasia-bk@localhost:5432/verifydb',
        });

        expect(result.code).toBe(0);
      });

      it('role verifikasi yang TUNDUK RLS: query hitung gagal (row_security=off) -> [GAGAL] dan exit 1, BUKAN "0 sama dengan 0" palsu', async () => {
        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          STUB_COUNT_FAIL_UNDER_RLS_OFF: '1',
          VERIFY_DATABASE_URL: 'postgresql://bk:rahasia-bk@localhost:5432/verifydb',
        });

        expect(result.code).toBe(1);
        expect(result.stdout).toContain('[GAGAL]');
        expect(result.stdout).toContain('ERROR');
      });

      it('jumlah baris berbeda dari metadata tetap terdeteksi', async () => {
        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          STUB_COUNT: '4',
          VERIFY_DATABASE_URL: 'postgresql://bk:rahasia-bk@localhost:5432/verifydb',
        });

        expect(result.code).toBe(1);
        expect(result.stdout).toContain('[GAGAL]');
      });

      it('metadata lama (hanya 3 tabel) tetap bisa diverifikasi: tabel yang tidak ada di metadata dilewati', async () => {
        fs.writeFileSync(
          `${dumpFile}.meta`,
          ['users', 'events', 'products'].map((table) => `rowcount_${table}=5`).join('\n') + '\n'
        );

        const result = await run('verify-backup.sh', [dumpFile], {
          ...baseEnv(),
          VERIFY_DATABASE_URL: 'postgresql://bk:rahasia-bk@localhost:5432/verifydb',
        });

        expect(result.code).toBe(0);
        expect(result.stdout.match(/\[LEWATI\]/g)).toHaveLength(3);
      });
    });

    describe('restore-db.sh', () => {
      it('konfirmasi tidak mencetak password database ke layar (user:***@host)', async () => {
        const dumpFile = path.join(dir, 'backup_x.dump');
        fs.writeFileSync(dumpFile, 'DUMP');

        const result = await run('restore-db.sh', [dumpFile], baseEnv(), 'no\n');

        expect(result.code).toBe(1);
        expect(result.stdout).toContain('postgresql://app:***@localhost:5432/proddb');
        expect(result.stdout).not.toContain('rahasia-prod');
        expect(log('pg_restore.log')).toBe('');
      });
    });
  }
);
