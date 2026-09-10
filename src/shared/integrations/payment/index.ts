import { env } from '../../config/env';
import { logger } from '../../logger';
import type { PaymentProvider } from './payment.provider';
import { logPaymentProvider } from './log-payment.provider';
import { stripePaymentProvider } from './stripe-payment.provider';

export type {
  PaymentProvider,
  CreatePaymentIntentInput,
  PaymentIntentResult,
} from './payment.provider';

function buildPaymentProvider(): PaymentProvider {
  if (env.PAYMENT_PROVIDER === 'stripe') {
    if (!env.STRIPE_SECRET_KEY) {
      logger.warn(
        'PAYMENT_PROVIDER=stripe tapi STRIPE_SECRET_KEY kosong — fallback ke log provider'
      );
      return logPaymentProvider;
    }
    return stripePaymentProvider;
  }

  return logPaymentProvider;
}

export const paymentProvider: PaymentProvider = buildPaymentProvider();
