import type { Request, Response } from 'express';
import { logger } from '../../../shared/logger';
import { env } from '../../../shared/config/env';
import { UnauthorizedError } from '../../../shared/utils/http-error';
import { sendSuccess } from '../../../shared/utils/response';

/**
 * Payload webhook Alertmanager — dipangkas ke field yang benar-benar
 * dipakai di sini. Bentuk lengkapnya jauh lebih besar (lihat
 * https://prometheus.io/docs/alerting/latest/configuration/#webhook_config),
 * tapi kita tidak butuh validasi Zod penuh untuk endpoint internal
 * yang sumbernya sudah dipercaya (jaringan Docker internal, opsional
 * shared secret — lihat `verifyWebhookSecret` di bawah).
 */
interface AlertmanagerWebhookPayload {
  status: 'firing' | 'resolved';
  alerts: Array<{
    status: 'firing' | 'resolved';
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
  }>;
}

/**
 * Controller Layer — SENGAJA tidak ada Service/Repository di belakang
 * endpoint ini (beda dari modul lain di codebase ini): tidak ada state
 * yang disimpan, tidak ada logika bisnis — satu-satunya tanggung jawab
 * endpoint ini adalah menjembatani notifikasi Alertmanager ke sistem
 * logging (Pino, yang di production terhubung ke log aggregator) &
 * Sentry, supaya alert operasional juga tercatat di tempat yang sama
 * dengan error aplikasi, bukan cuma "menghilang" ke channel notifikasi
 * eksternal yang mungkin tidak dikonfigurasi di semua environment.
 */
export function handleAlertmanagerWebhook(req: Request, res: Response): void {
  verifyWebhookSecret(req);

  const payload = req.body as AlertmanagerWebhookPayload;

  for (const alert of payload.alerts ?? []) {
    const logPayload = {
      alertname: alert.labels.alertname,
      severity: alert.labels.severity,
      status: alert.status,
      summary: alert.annotations.summary,
      description: alert.annotations.description,
      startsAt: alert.startsAt,
    };

    // `severity: critical` yang FIRING dicatat sebagai `logger.error`
    // (bukan `warn`) — supaya kalau log aggregator production dikonfigurasi
    // alert dari LEVEL LOG (bukan hanya dari Alertmanager langsung),
    // insiden critical tetap ikut terangkat lewat jalur itu juga.
    if (alert.status === 'firing' && alert.labels.severity === 'critical') {
      logger.error(logPayload, `[Alertmanager] FIRING: ${alert.labels.alertname}`);
    } else if (alert.status === 'firing') {
      logger.warn(logPayload, `[Alertmanager] FIRING: ${alert.labels.alertname}`);
    } else {
      logger.info(logPayload, `[Alertmanager] RESOLVED: ${alert.labels.alertname}`);
    }
  }

  sendSuccess(res, 200, 'Webhook diterima', null);
}

function verifyWebhookSecret(req: Request): void {
  if (!env.ALERTMANAGER_WEBHOOK_SECRET) {
    return; // verifikasi dilewati — lihat catatan di env.ts
  }

  const provided = req.headers['x-webhook-secret'];
  if (provided !== env.ALERTMANAGER_WEBHOOK_SECRET) {
    throw new UnauthorizedError('Webhook secret tidak valid');
  }
}
