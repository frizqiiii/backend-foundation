import { env } from '../../config/env';
import { logger } from '../../logger';
import { resilientCall } from '../../reliability/resilient-call';
import { NOTIFICATION_PROVIDER_POLICY } from '../../reliability/policies';
import type { EmailProvider, EmailPayload } from './email.provider';

/**
 * Implementasi sungguhan pertama — memanggil REST API Resend
 * (https://resend.com/docs/api-reference/emails/send-email) langsung
 * lewat `fetch` bawaan Node, TANPA SDK vendor. Dipilih sebagai contoh
 * provider REST API-based karena API-nya sesederhana satu POST dengan
 * Bearer token — memberi pola yang jelas untuk provider serupa
 * (SendGrid, Mailgun, Postmark) yang APInya juga REST + Bearer token,
 * tinggal ganti URL/field body.
 *
 * SENGAJA TIDAK memakai SDK resmi vendor (`resend` npm package) —
 * menghindari menambah dependency npm baru HANYA untuk satu panggilan
 * HTTP sederhana (lihat juga alasan yang sama di provider SMS/push/
 * search/payment lain di Phase 15 ini).
 *
 * Phase 18 (Enterprise Reliability) — `fetch` dibungkus
 * `resilientCall` (timeout + retry + circuit breaker + bulkhead, lihat
 * `shared/reliability/`) memakai preset `NOTIFICATION_PROVIDER_POLICY`
 * — sebelumnya panggilan ini tidak punya batas waktu sama sekali,
 * berisiko menggantung tanpa batas kalau Resend hang.
 */
export const resendEmailProvider: EmailProvider = {
  async send(payload: EmailPayload): Promise<void> {
    const response = await resilientCall(
      'email.resend',
      (signal) =>
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: env.RESEND_FROM_EMAIL,
            to: payload.to,
            subject: payload.subject,
            text: payload.text,
          }),
          signal,
        }),
      NOTIFICATION_PROVIDER_POLICY
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error(
        { status: response.status, body, to: payload.to },
        'ResendEmailProvider: gagal mengirim email'
      );
      throw new Error(`Resend API mengembalikan status ${response.status}`);
    }
  },
};
