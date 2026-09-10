import crypto from 'node:crypto';
import { logger } from '../../logger';
import type {
  PaymentProvider,
  CreatePaymentIntentInput,
  PaymentIntentResult,
} from './payment.provider';

export const logPaymentProvider: PaymentProvider = {
  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult> {
    const id = `log_pi_${crypto.randomUUID()}`;
    logger.warn(
      { id, amount: input.amount, currency: input.currency },
      '[PAYMENT PROVIDER: log — TIDAK ADA TRANSAKSI SUNGGUHAN YANG DIBUAT]'
    );
    return { id, status: 'requires_payment_method' };
  },
};
