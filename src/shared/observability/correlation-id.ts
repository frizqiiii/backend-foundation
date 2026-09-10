import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Correlation ID Context (Phase 13 — Enterprise Observability) — ID
 * unik per-request yang mengalir lintas SELURUH log yang dihasilkan
 * saat memproses request itu (dan lintas SERVICE kalau di masa depan
 * ada pemanggilan service lain yang meneruskan header yang sama).
 *
 * Pola AsyncLocalStorage IDENTIK dengan `shared/tenant/tenant-context.ts`
 * — alasannya sama: kode di layer Repository/Service/queue job yang
 * tidak punya akses langsung ke `req` tetap perlu bisa menyisipkan
 * correlation ID yang sama ke log yang mereka hasilkan, supaya SATU
 * request bisa ditelusuri utuh dari log manapun asalnya.
 *
 * BEDA dari trace ID OpenTelemetry (`shared/observability/tracing.ts`)
 * — correlation ID adalah konsep APLIKASI (dikontrol penuh oleh kode
 * ini, bisa diteruskan lewat header antar service secara manual),
 * sedangkan trace ID adalah konsep OTEL (dikelola SDK, mengikuti
 * format W3C Trace Context). Keduanya SENGAJA dijaga terpisah —
 * mencampurnya akan membuat salah satu tidak lagi bisa diandalkan
 * kalau OpenTelemetry-nya tidak aktif (mis. di test, atau kalau
 * `OTEL_EXPORTER_OTLP_ENDPOINT` belum dikonfigurasi).
 */
const storage = new AsyncLocalStorage<string>();

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run(correlationId, fn);
}

/**
 * Mengembalikan `undefined` (BUKAN melempar error) kalau dipanggil di
 * luar `runWithCorrelationId` — sama alasannya dengan
 * `getTenantContext`: kode yang jalan lewat test unit atau job
 * scheduler yang belum diinstrumentasi correlation ID tetap harus
 * bisa berjalan, hanya saja lognya tidak akan tertaut ke request
 * manapun.
 */
export function getCorrelationId(): string | undefined {
  return storage.getStore();
}
