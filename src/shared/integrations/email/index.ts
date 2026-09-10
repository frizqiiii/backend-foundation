import { env } from '../../config/env';
import { logger } from '../../logger';
import type { EmailProvider } from './email.provider';
import { logEmailProvider } from './log-email.provider';
import { resendEmailProvider } from './resend-email.provider';

export type { EmailProvider, EmailPayload } from './email.provider';

function buildEmailProvider(): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend') {
    if (!env.RESEND_API_KEY) {
      logger.warn('EMAIL_PROVIDER=resend tapi RESEND_API_KEY kosong — fallback ke log provider');
      return logEmailProvider;
    }
    return resendEmailProvider;
  }

  return logEmailProvider;
}

export const emailProvider: EmailProvider = buildEmailProvider();
