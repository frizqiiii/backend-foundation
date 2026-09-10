import pino from 'pino';
import { trace, context } from '@opentelemetry/api';
import { env } from './config/env';

/**
 * Logger terstruktur (Pino) — menggantikan wrapper `console.log` yang
 * sebelumnya ada di file ini. Output JSON di production (siap
 * di-ingest log aggregator seperti Datadog/CloudWatch/Loki), format
 * berwarna & mudah dibaca manusia (`pino-pretty`) di development.
 *
 * Dipanggil dengan konvensi asli Pino: `logger.error(objek, pesan)` —
 * objek dulu, baru pesan (kebalikan dari `console.error(pesan, objek)`
 * yang mungkin lebih familiar).
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  // Phase 13 — menyisipkan `trace_id`/`span_id` ke SETIAP baris log
  // secara otomatis, kalau ada span OpenTelemetry aktif saat log itu
  // ditulis. `@opentelemetry/api` AMAN diimpor tanpa syarat (tidak
  // butuh `OTEL_ENABLED=true`) — package ini murni interface dengan
  // implementasi no-op bawaan; `trace.getSpan(context.active())`
  // mengembalikan `undefined` kalau tidak ada SDK tracing yang
  // terpasang (mis. `OTEL_ENABLED=false`, atau saat test berjalan),
  // sehingga mixin ini cukup mengembalikan objek kosong — TIDAK
  // pernah melempar error karena tracing tidak aktif.
  mixin() {
    const span = trace.getSpan(context.active());
    if (!span) {
      return {};
    }
    const { traceId, spanId } = span.spanContext();
    return { trace_id: traceId, span_id: spanId };
  },
  transport:
    env.NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        }
      : undefined,
});
