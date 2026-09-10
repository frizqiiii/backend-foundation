import { Queue } from 'bullmq';
import { queueConnection } from './connection';
import { bullMQTelemetry } from '../observability/bullmq-telemetry';

/**
 * Payload job — HANYA berisi ID export request (`exportJobId`, baris
 * `ExportJob` yang sudah dibuat DI DATABASE oleh `ExportService`
 * SEBELUM job di-enqueue) plus data minimal untuk memprosesnya, BUKAN
 * hasil query data yang mau diexport itu sendiri — data sesungguhnya
 * (bisa ribuan baris) diambil ULANG oleh worker saat job diproses,
 * bukan dibawa lewat payload job (payload BullMQ disimpan di Redis,
 * tidak didesain untuk muatan besar).
 */
export interface ExportJobData {
  exportJobId: string;
  type:
    | 'USERS'
    | 'AUDIT_LOG'
    | 'DASHBOARD_STATS'
    // Phase 20 (Reporting & Analytics Service) — lihat
    // `ExportService.buildDataset` untuk cara masing-masing diproses.
    | 'USER_STATISTICS'
    | 'EVENT_STATISTICS'
    | 'PRODUCT_STATISTICS'
    | 'SYSTEM_STATISTICS'
    | 'DAILY_ACTIVE_USERS';
  format: 'CSV' | 'XLSX' | 'PDF';
  userId: string;
  tenantId: string | null;
}

/**
 * SENGAJA TIDAK ada `enqueueExportJob()`/`processExportJob()` di sini
 * — BEDA dari `email.queue.ts`/`webhook-delivery.queue.ts` yang
 * keduanya membungkus logic pemrosesan lengkap di file queue.
 * Alasannya: memproses export BUTUH akses Prisma (query
 * users/audit-log/dashboard-stats) + `objectStorageProvider` — kalau
 * logic itu ditaruh di sini (`shared/queue/`), `shared/` jadi
 * bergantung ke business logic (`modules/exports/`), MEMBALIK arah
 * dependency Clean Architecture yang jadi fondasi seluruh aplikasi
 * ini (`shared/` HARUS jadi lapisan paling dasar, tidak boleh tahu
 * apa pun soal modul bisnis). Logic pemrosesan sesungguhnya ada di
 * `ExportService.processExportJob()` (modules/exports) — dipanggil
 * LANGSUNG oleh `ExportService` sendiri untuk fallback sinkron, dan
 * oleh `src/workers/export.worker.ts` untuk mode antrian sungguhan.
 * File ini murni definisi `Queue` BullMQ-nya saja.
 */
export const exportQueue = queueConnection
  ? new Queue<ExportJobData>('export', {
      connection: queueConnection,
      telemetry: bullMQTelemetry ?? undefined,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 1000 },
      },
    })
  : null;
