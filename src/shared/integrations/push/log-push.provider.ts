import { logger } from '../../logger';
import type { PushProvider, PushPayload } from './push.provider';

export const logPushProvider: PushProvider = {
  async send(payload: PushPayload): Promise<void> {
    logger.warn(
      { deviceToken: payload.deviceToken, title: payload.title },
      '[PUSH PROVIDER: log — NOTIFIKASI PUSH TIDAK BENAR-BENAR DIKIRIM]'
    );
  },
};
