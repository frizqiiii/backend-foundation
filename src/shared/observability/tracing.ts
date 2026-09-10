import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
// Type-only — DIHAPUS SELURUHNYA saat kompilasi (tidak menghasilkan
// `require()` apa pun), jadi tidak melanggar urutan "harus jadi import
// pertama" yang dijelaskan di komentar `startTracing` di bawah. Nilai
// sungguhannya tetap diambil lewat `require()` di DALAM fungsi.
import type { env as EnvType } from '../config/env';

/**
 * Distributed Tracing bootstrap (Phase 13 — Enterprise Observability).
 *
 * KRITIS — file ini HARUS di-import PALING PERTAMA, sebelum module lain
 * apa pun (termasuk `express`, `pg`, `ioredis`) sempat di-require oleh
 * proses. Auto-instrumentation OpenTelemetry bekerja dengan MEMATCH-PATCH
 * modul Node.js saat pertama kali di-require — kalau modul target sudah
 * ter-require lebih dulu (mis. lewat import lain yang dieksekusi sebelum
 * file ini), instrumentasinya TIDAK AKAN terpasang untuk modul tersebut
 * sama sekali, tanpa error apa pun yang menandakannya (silent gap). Lihat
 * `server.ts`/`worker.ts` untuk urutan import yang benar.
 *
 * TIDAK diimpor dari `app.ts` — `app.ts` juga dipakai oleh
 * `app.integration.spec.ts`/`app.e2e.spec.ts` (test), dan SDK tracing
 * (efek samping global: mem-patch modul Node bawaan) tidak boleh ikut
 * aktif saat test berjalan.
 *
 * OPT-IN lewat `OTEL_ENABLED` (default `false`) — sama filosofi dengan
 * Sentry (`shared/config/sentry.ts`): tracing tidak boleh jadi prasyarat
 * aplikasi bisa start. Kalau `OTEL_ENABLED=false`, fungsi ini TIDAK
 * melakukan apa pun sama sekali (bukan sekadar exporter yang no-op) —
 * tidak ada overhead instrumentasi apa pun untuk deployment yang belum
 * butuh tracing.
 */
export function startTracing(): void {
  // Import `env` di DALAM fungsi (bukan di top-level file) — mengimpor
  // `shared/config/env` men-trigger validasi environment variable
  // (fail-fast), yang idealnya terjadi lewat urutan startup normal
  // (`server.ts`), bukan sebagai side-effect dari sekadar meng-import
  // modul ini.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { env } = require('../config/env') as { env: typeof EnvType };

  if (!env.OTEL_ENABLED) {
    return;
  }

  const sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown',
      'deployment.environment': env.NODE_ENV,
    }),
    traceExporter: new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Instrumentasi filesystem SENGAJA dimatikan — menghasilkan
        // span untuk SETIAP `fs.readFile`/`fs.stat` dst (termasuk yang
        // dilakukan Node/dependency secara internal, bukan hanya kode
        // aplikasi), volumenya sangat besar dan hampir tidak pernah
        // berguna untuk investigasi request HTTP — noise, bukan sinyal.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
      // Prisma (Phase 16) — TIDAK termasuk dalam auto-instrumentations-node
      // (bukan library yang di-patch otomatis), harus didaftarkan manual.
      // WAJIB dipasangkan dengan `previewFeatures = ["tracing"]` di
      // `prisma/schema.prisma` (project ini masih di Prisma 5.x, tracing
      // baru General Availability tanpa flag ini sejak Prisma 6.1) — tanpa
      // preview flag itu, instrumentation ini terpasang tapi tidak akan
      // pernah menghasilkan span (silent no-op).
      new PrismaInstrumentation(),
    ],
  });

  sdk.start();

  // Graceful shutdown — flush span yang masih di buffer sebelum proses
  // benar-benar berhenti, supaya trace dari detik-detik terakhir sebelum
  // shutdown tidak hilang begitu saja.
  process.on('SIGTERM', () => {
    sdk.shutdown().catch((error) => {
      // eslint-disable-next-line no-console -- logger (Pino) belum tentu masih bisa dipakai di titik shutdown ini
      console.error('Gagal shutdown OpenTelemetry SDK dengan bersih:', error);
    });
  });
}
