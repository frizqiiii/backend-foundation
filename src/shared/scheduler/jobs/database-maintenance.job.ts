import { prisma } from '../../config/database';
import { logger } from '../../logger';
import type { ScheduledJobDefinition, JobRunSummary } from '../scheduler.types';

/**
 * Daftar tabel INTI aplikasi (bukan hasil input user — daftar tetap
 * yang di-hardcode) yang di-`ANALYZE` secara berkala. `ANALYZE`
 * memperbarui statistik yang dipakai PostgreSQL query planner untuk
 * memilih execution plan (index scan vs sequential scan, dst) — tanpa
 * ini, statistik jadi usang seiring data bertambah/berubah dan
 * planner bisa memilih plan yang semakin tidak optimal dari waktu ke
 * waktu, meski index-nya sendiri sudah benar.
 *
 * Nama tabel di-hardcode (bukan di-generate dari input mana pun) —
 * aman dipakai langsung di `$executeRawUnsafe` karena tidak ada jalur
 * user input yang bisa memengaruhi string ini.
 *
 * P3 (Database Audit) — daftar ini sebelumnya ketinggalan zaman:
 * hanya mencakup tabel dari fase-fase awal (sampai sekitar Phase 8),
 * TIDAK termasuk tabel yang lahir di fase-fase Enterprise berikutnya
 * (Phase 11 Multi-tenancy, Phase 12 Security, Phase 15 Integration,
 * Phase 19 Platform) walau beberapa di antaranya sama-sama punya
 * index komposit yang efektivitasnya bergantung pada statistik yang
 * segar — terutama `audit_logs` (paling sering ditulis dari
 * SELURUH aksi CRUD/keamanan aplikasi, dengan 3 index termasuk 2
 * composite) dan `activity_logs`. Ditambahkan di sini untuk menutup
 * gap tersebut.
 */
const CORE_TABLES = [
  'users',
  'refresh_tokens',
  'blacklisted_tokens',
  'products',
  'events',
  'product_upgrade_logs',
  'tenants',
  'audit_logs',
  'activity_logs',
  'api_keys',
  'webhook_endpoints',
  'export_jobs',
] as const;

/**
 * `ANALYZE` dijalankan tabel-per-tabel (bukan satu perintah
 * `ANALYZE;` untuk seluruh database) supaya kalau satu tabel gagal
 * (mis. lock kontensi sesaat), tabel lain tetap sempat diproses —
 * kegagalan satu tabel di-log sebagai warning, bukan menggagalkan
 * seluruh job (beda dari job lain yang boleh gagal total & di-retry
 * oleh `job-runner.ts`; di sini "sebagian berhasil" tetap dianggap
 * sukses, karena analyze bukan operasi atomik yang butuh semua-atau-
 * tidak-sama-sekali).
 */
async function analyzeTable(tableName: string): Promise<boolean> {
  try {
    await prisma.$executeRawUnsafe(`ANALYZE "${tableName}"`);
    return true;
  } catch (error) {
    logger.warn(
      { err: error, table: tableName },
      `Database maintenance: ANALYZE gagal untuk tabel "${tableName}"`
    );
    return false;
  }
}

/**
 * Jadwal: setiap Minggu jam 03:00 — mingguan (bukan harian seperti
 * job cleanup lain) karena `ANALYZE` lebih berat & manfaatnya baru
 * terasa setelah cukup banyak perubahan data terakumulasi; menjalankan
 * terlalu sering hanya menambah beban I/O tanpa manfaat sebanding.
 */
async function runDatabaseMaintenance(): Promise<JobRunSummary> {
  const results = await Promise.all(CORE_TABLES.map((table) => analyzeTable(table)));
  const analyzedCount = results.filter(Boolean).length;

  return {
    message: `ANALYZE selesai untuk ${analyzedCount}/${CORE_TABLES.length} tabel inti`,
    details: { tablesAnalyzed: analyzedCount, tablesTotal: CORE_TABLES.length },
  };
}

export const databaseMaintenanceJob: ScheduledJobDefinition = {
  name: 'database-maintenance',
  cronExpression: '0 3 * * 0',
  run: runDatabaseMaintenance,
};
