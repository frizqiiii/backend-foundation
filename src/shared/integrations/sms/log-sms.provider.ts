import { logger } from '../../logger';
import type { SmsProvider, SmsPayload } from './sms.provider';

export const logSmsProvider: SmsProvider = {
  async send(payload: SmsPayload): Promise<void> {
    logger.warn({ to: payload.to }, '[SMS PROVIDER: log — SMS TIDAK BENAR-BENAR DIKIRIM]');
  },
};
