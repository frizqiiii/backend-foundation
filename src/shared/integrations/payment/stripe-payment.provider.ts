import { env } from '../../config/env';
import { logger } from '../../logger';
import { resilientCall } from '../../reliability/resilient-call';
import { PAYMENT_PROVIDER_POLICY } from '../../reliability/policies';
import type {
  PaymentProvider,
  CreatePaymentIntentInput,
  PaymentIntentResult,
} from './payment.provider';

/**
 * Stripe REST API (https://stripe.com/docs/api/payment_intents/create)
 * lewat `fetch` langsung, TANPA SDK `stripe` — sama alasannya seperti
 * provider lain di Phase 15 ini. Stripe memakai body
 * `application/x-www-form-urlencoded` (bukan JSON, sama seperti
 * Twilio) dan Bearer token sebagai secret key.
 *
 * KEJUJURAN SOAL KETERBATASAN — implementasi ini HANYA membuat
 * PaymentIntent, TIDAK menangani webhook konfirmasi pembayaran
 * (Stripe mengonfirmasi status pembayaran async lewat webhook,
 * verifikasi signature-nya beda mekanisme dari
 * `shared/integrations/webhook/` — itu untuk webhook KELUAR yang
 * dikirim aplikasi ini, bukan webhook MASUK dari Stripe). Implementasi
 * penuh siklus pembayaran (konfirmasi, refund, dispute) adalah
 * pekerjaan lanjutan.
 *
 * Phase 18 — memakai `PAYMENT_PROVIDER_POLICY` (retry LEBIH SEDIKIT +
 * bulkhead LEBIH SEMPIT dari provider notifikasi) — lihat rationale
 * lengkap di `shared/reliability/policies.ts`. Idempotency
 * sungguhan (Stripe `Idempotency-Key` header) BELUM ditambahkan di
 * iterasi ini — perlu `idempotencyKey` eksplisit dari pemanggil
 * (bukan dibuat otomatis di sini) supaya retry di layer ini tidak
 * berisiko membuat PaymentIntent dobel; kapabilitas lanjutan, sama
 * seperti refund/webhook-signature-verification yang disebut di atas.
 */
export const stripePaymentProvider: PaymentProvider = {
  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult> {
    const body = new URLSearchParams({
      amount: String(input.amount),
      currency: input.currency,
      ...(input.description ? { description: input.description } : {}),
    });

    const response = await resilientCall(
      'payment.stripe',
      (signal) =>
        fetch('https://api.stripe.com/v1/payment_intents', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal,
        }),
      PAYMENT_PROVIDER_POLICY
    );

    const json = (await response.json()) as {
      id?: string;
      status?: string;
      client_secret?: string;
      error?: { message: string };
    };

    if (!response.ok || !json.id) {
      logger.error(
        { status: response.status, error: json.error, amount: input.amount },
        'StripePaymentProvider: gagal membuat payment intent'
      );
      throw new Error(json.error?.message ?? `Stripe API mengembalikan status ${response.status}`);
    }

    return { id: json.id, status: json.status ?? 'unknown', clientSecret: json.client_secret };
  },
};
