import { logger } from '../../shared/logger';

/**
 * R20 — daftar event type webhook yang BENAR-BENAR dipicu aplikasi. Satu sumber kebenaran: pemanggil memakai konstanta
 * ini (bukan string literal), supaya salah ketik tidak diam-diam membuat webhook tidak pernah terkirim.
 */
export const WEBHOOK_EVENT_TYPES = {
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPGRADED: 'product.upgraded',
  PRODUCT_DELETED: 'product.deleted',
  EVENT_CREATED: 'event.created',
  EVENT_UPDATED: 'event.updated',
  EVENT_DELETED: 'event.deleted',
} as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[keyof typeof WEBHOOK_EVENT_TYPES];

/** Kontrak minimal yang dibutuhkan service bisnis; `WebhookService` memenuhinya. */
export interface WebhookTrigger {
  trigger(eventType: string, payload: Record<string, unknown>): Promise<void>;
}

/**
 * R20 — memicu webhook TANPA menunggu dan TANPA pernah melempar ke pemanggil.
 *
 * Kenapa tidak di-`await`: tanpa Redis, `enqueueWebhookDelivery` mengirim HTTP secara sinkron (sampai 10 dtk per
 * endpoint). Kalau ditunggu, request bisnis (mis. POST /products) ikut lambat dan transaksi request tertahan terbuka.
 * Konteks tenant tetap terbawa karena `AsyncLocalStorage` merambat ke promise yang dimulai di dalam request.
 * `trigger` sendiri tidak melempar; `.catch` di sini hanya pengaman terakhir agar tidak ada unhandled rejection.
 * Tanpa `trigger` (undefined, mis. di unit test lama) fungsi ini tidak melakukan apa pun.
 */
export function dispatchWebhook(
  webhooks: WebhookTrigger | undefined,
  eventType: WebhookEventType,
  payload: Record<string, unknown>
): void {
  if (!webhooks) return;
  webhooks.trigger(eventType, payload).catch((error: unknown) => {
    logger.warn(
      { err: error, eventType },
      'dispatchWebhook: trigger gagal — operasi bisnis tidak terpengaruh'
    );
  });
}
