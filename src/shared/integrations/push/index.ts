import { env } from '../../config/env';
import { logger } from '../../logger';
import type { PushProvider } from './push.provider';
import { logPushProvider } from './log-push.provider';
import { fcmPushProvider } from './fcm-push.provider';

export type { PushProvider, PushPayload } from './push.provider';

function buildPushProvider(): PushProvider {
  if (env.PUSH_PROVIDER === 'fcm') {
    if (!env.FCM_SERVER_KEY) {
      logger.warn('PUSH_PROVIDER=fcm tapi FCM_SERVER_KEY kosong — fallback ke log provider');
      return logPushProvider;
    }
    return fcmPushProvider;
  }

  return logPushProvider;
}

export const pushProvider: PushProvider = buildPushProvider();
