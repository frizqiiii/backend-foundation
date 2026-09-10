import { env } from '../../config/env';
import { logger } from '../../logger';
import { resilientCall } from '../../reliability/resilient-call';
import { NOTIFICATION_PROVIDER_POLICY } from '../../reliability/policies';
import type { SmsProvider, SmsPayload } from './sms.provider';

/**
 * Twilio REST API (https://www.twilio.com/docs/sms/api/message-resource)
 * lewat `fetch` langsung, TANPA SDK `twilio` — sama alasannya seperti
 * `resend-email.provider.ts`. Autentikasi Twilio memakai HTTP Basic
 * Auth (Account SID sebagai username, Auth Token sebagai password) dan
 * body `application/x-www-form-urlencoded` — BUKAN JSON, beda dari
 * kebanyakan API REST modern, jadi dicatat eksplisit di sini supaya
 * tidak salah tebak kalau menambah provider serupa.
 *
 * Phase 18 — lihat catatan `resilientCall` di `resend-email.provider.ts`.
 */
export const twilioSmsProvider: SmsProvider = {
  async send(payload: SmsPayload): Promise<void> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    const basicAuth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString(
      'base64'
    );

    const body = new URLSearchParams({
      To: payload.to,
      From: env.TWILIO_FROM_NUMBER,
      Body: payload.message,
    });

    const response = await resilientCall(
      'sms.twilio',
      (signal) =>
        fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basicAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal,
        }),
      NOTIFICATION_PROVIDER_POLICY
    );

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      logger.error(
        { status: response.status, body: responseBody, to: payload.to },
        'TwilioSmsProvider: gagal mengirim SMS'
      );
      throw new Error(`Twilio API mengembalikan status ${response.status}`);
    }
  },
};
