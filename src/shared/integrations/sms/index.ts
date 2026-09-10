import { env } from '../../config/env';
import { logger } from '../../logger';
import type { SmsProvider } from './sms.provider';
import { logSmsProvider } from './log-sms.provider';
import { twilioSmsProvider } from './twilio-sms.provider';

export type { SmsProvider, SmsPayload } from './sms.provider';

function buildSmsProvider(): SmsProvider {
  if (env.SMS_PROVIDER === 'twilio') {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
      logger.warn(
        'SMS_PROVIDER=twilio tapi kredensial Twilio belum lengkap — fallback ke log provider'
      );
      return logSmsProvider;
    }
    return twilioSmsProvider;
  }

  return logSmsProvider;
}

export const smsProvider: SmsProvider = buildSmsProvider();
