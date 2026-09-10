import { BullMQOtel } from 'bullmq-otel';
import type { Telemetry } from 'bullmq';
import { env } from '../config/env';

/**
 * Telemetry BullMQ (Phase 16 — Enterprise Observability).
 *
 * BullMQ TIDAK ter-cover oleh `getNodeAutoInstrumentations()` di
 * `tracing.ts` — tidak ada mekanisme monkey-patch otomatis untuk
 * BullMQ seperti untuk Express/Redis. Sebagai gantinya, BullMQ v5+
 * punya interface `Telemetry` sendiri yang harus di-inject secara
 * EKSPLISIT ke tiap `Queue`/`Worker`/`FlowProducer` lewat opsi
 * `telemetry` — `bullMQTelemetry` di bawah adalah instance TUNGGAL
 * yang dipakai di semua queue (`email.queue.ts`, `notification.queue.ts`,
 * dst) dan semua worker (`workers/*.worker.ts`) supaya span yang
 * dihasilkan konsisten satu tracer/nama.
 *
 * `enableMetrics: true` — selain span, BullMQOtel juga membuat
 * counter/histogram lewat OTel Meter (durasi job, completed/failed
 * count) yang independen dari `queue.metrics.ts` (custom Prometheus
 * metrics yang sudah ada) — dua sumber metrik yang saling melengkapi,
 * bukan duplikat: yang satu lewat OTel Collector, satu lagi lewat
 * `/metrics` Prometheus langsung.
 *
 * `null` kalau `OTEL_ENABLED=false` — SAMA filosofinya dengan
 * `tracing.ts`: kalau tracing dimatikan, tidak boleh ada instance
 * `BullMQOtel` yang dibuat sama sekali (bukan sekadar exporter no-op),
 * supaya tidak ada overhead span-creation untuk deployment yang belum
 * butuh observability ini. Tiap `Queue`/`Worker` yang memakainya HARUS
 * treat ini sebagai opsional (`telemetry: bullMQTelemetry ?? undefined`).
 */
export const bullMQTelemetry: Telemetry<unknown> | null = env.OTEL_ENABLED
  ? new BullMQOtel({
      tracerName: env.OTEL_SERVICE_NAME,
      meterName: env.OTEL_SERVICE_NAME,
      version: process.env.npm_package_version ?? 'unknown',
      enableMetrics: true,
    })
  : null;
