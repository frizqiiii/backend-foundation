import { Queue } from 'bullmq';
import { queueConnection } from './connection';
import { logger } from '../logger';
import { signWebhookPayload } from '../integrations/webhook/webhook-signer';
import { bullMQTelemetry } from '../observability/bullmq-telemetry';
import { resilientCall } from '../reliability/resilient-call';
import { WEBHOOK_DELIVERY_POLICY } from '../reliability/policies';
import { assertSafeOutboundUrl } from '../security/ssrf-guard';

export interface WebhookDeliveryJobData {
  webhookEndpointId: string;
  url: string;
  secret: string;
  eventType: string;
  payload: Record<string, unknown>;
  /**
   * Finding #22 (P1 Security Hardening, Webhook Security) — ID unik
   * SATU KEJADIAN pengiriman, dibuat SEKALI oleh `WebhookService.trigger`
   * (bukan di sini) dan tetap SAMA di setiap percobaan retry BullMQ
   * untuk job ini — BEDA dari `timestamp`/signature di
   * `processWebhookDeliveryJob` yang SENGAJA berbeda di setiap
   * percobaan (setiap retry memang benar-benar terjadi di titik waktu
   * baru). Dikirim sebagai header `X-Webhook-Delivery-Id`, supaya
   * penerima yang mengimplementasikan cache "ID yang sudah pernah
   * diproses" bisa membedakan RETRY YANG SAH (ID sama, timestamp
   * beda — server penerima tadi sempat menerima tapi responsnya
   * hilang di jalan) dari PERCOBAAN REPLAY oleh penyerang (ID sama
   * yang seharusnya sudah pernah diproses & disimpan, muncul lagi
   * tanpa alasan).
   */
  deliveryId: string;
}

/**
 * Webhook Delivery Queue (Phase 15) — pola SAMA PERSIS dengan
 * `email.queue.ts` (lihat komentar lengkap di sana untuk
 * `defaultJobOptions`) — webhook ke server pihak ketiga PALING sering
 * gagal sementara dari SEMUA fitur di aplikasi ini (server penerima
 * bisa down, lambat, rate-limit, dst — sepenuhnya di luar kendali
 * aplikasi ini), jadi retry eksponensial jauh lebih penting di sini
 * daripada di queue lain.
 */
export const webhookDeliveryQueue = queueConnection
  ? new Queue<WebhookDeliveryJobData>('webhook-delivery', {
      connection: queueConnection,
      telemetry: bullMQTelemetry ?? undefined,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    })
  : null;

/**
 * Titik masuk TUNGGAL untuk mengirim webhook — dipanggil
 * `WebhookService.trigger` untuk SETIAP endpoint yang cocok dengan
 * event yang terjadi. Sama pola fallback-sinkron dengan
 * `enqueueEmailJob`: TANPA Redis, webhook tetap terkirim (tidak
 * pernah diam-diam hilang), hanya saja mengirimnya jadi bagian dari
 * request yang memicu event tersebut (lebih lambat, tapi tetap
 * benar).
 */
export async function enqueueWebhookDelivery(data: WebhookDeliveryJobData): Promise<void> {
  if (webhookDeliveryQueue) {
    await webhookDeliveryQueue.add(data.eventType, data);
    return;
  }

  await processWebhookDeliveryJob(data);
}

/**
 * Logic pengiriman sesungguhnya — dipakai `webhook.worker.ts` (mode
 * antrian) MAUPUN `enqueueWebhookDelivery` (mode fallback sinkron),
 * persis pola `processEmailJob`. Signature HMAC dihitung DI SINI
 * (bukan saat enqueue) — memastikan signature selalu dihitung dari
 * payload PERSIS seperti yang akan dikirim, termasuk kalau job sempat
 * di-retry (payload yang sama, signature yang sama, bukan dihitung
 * ulang dari state yang mungkin sudah berubah).
 */
export async function processWebhookDeliveryJob(data: WebhookDeliveryJobData): Promise<void> {
  // Dicek ULANG di sini (bukan cuma di `WebhookService.register`) —
  // lihat komentar lengkap di `ssrf-guard.ts` soal kenapa satu kali
  // cek saat registrasi tidak cukup (DNS rebinding). Kegagalan di
  // sini SENGAJA dilempar sebagai error biasa (bukan ditangkap diam-
  // diam) supaya job ini masuk jalur retry/dead-letter yang sama
  // seperti kegagalan pengiriman lainnya — operator tetap terinformasi
  // lewat log, bukan gagal secara senyap.
  await assertSafeOutboundUrl(data.url);

  const body = JSON.stringify({ event: data.eventType, data: data.payload });
  // Finding #22 — timestamp BARU dihitung di SETIAP percobaan
  // (termasuk retry BullMQ), sengaja BEDA dari `deliveryId` (yang
  // dibuat sekali di `WebhookService.trigger` dan diteruskan apa
  // adanya lewat `data.deliveryId`) — lihat komentar lengkap pada
  // `deliveryId` di `WebhookDeliveryJobData` untuk alasannya.
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookPayload(body, data.secret, timestamp);

  // Key di-scope PER-HOST tujuan (bukan satu key global
  // `'webhook.delivery'`) — SENGAJA, supaya satu endpoint webhook
  // yang down (mis. milik satu tenant/user) tidak ikut membuka
  // circuit breaker untuk endpoint tenant/user LAIN yang sama sekali
  // tidak bermasalah. Tiap host tujuan punya breaker & bulkhead
  // sendiri-sendiri.
  const destinationHost = new URL(data.url).host;

  const response = await resilientCall(
    `webhook.delivery:${destinationHost}`,
    (signal) =>
      fetch(data.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Delivery-Id': data.deliveryId,
          'X-Webhook-Event': data.eventType,
        },
        body,
        signal,
      }),
    WEBHOOK_DELIVERY_POLICY
  );

  if (!response.ok) {
    logger.warn(
      { webhookEndpointId: data.webhookEndpointId, status: response.status, url: data.url },
      'Webhook delivery gagal — akan di-retry otomatis oleh BullMQ (lihat defaultJobOptions)'
    );
    // Melempar error SENGAJA — inilah yang membuat BullMQ menganggap
    // job ini gagal dan menjadwalkan retry (lihat `attempts`/`backoff`
    // di atas). Tanpa `throw`, job akan dianggap "berhasil" walau
    // penerima menolaknya.
    throw new Error(`Webhook delivery gagal dengan status ${response.status}`);
  }
}
