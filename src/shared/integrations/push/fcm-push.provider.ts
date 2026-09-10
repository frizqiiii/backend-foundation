import { env } from '../../config/env';
import { logger } from '../../logger';
import { resilientCall } from '../../reliability/resilient-call';
import { NOTIFICATION_PROVIDER_POLICY } from '../../reliability/policies';
import type { PushProvider, PushPayload } from './push.provider';

/**
 * Firebase Cloud Messaging — memakai LEGACY "server key" HTTP API
 * (`https://fcm.googleapis.com/fcm/send`, header `Authorization: key=...`),
 * BUKAN HTTP v1 API yang jadi standar resmi Google saat ini.
 *
 * KEJUJURAN SOAL KETERBATASAN INI (bukan terlewat, dipilih sadar):
 * HTTP v1 API mensyaratkan OAuth2 access token dari Google Service
 * Account (JWT yang ditandatangani dengan private key, ditukar ke
 * Google OAuth token endpoint, dan di-refresh berkala) — implementasi
 * penuhnya butuh library JWT-signing + token-caching yang di luar
 * cakupan "satu panggilan fetch sederhana" seperti provider Phase 15
 * lain di sini. Legacy API dipilih sebagai referensi PATTERN
 * (interface + factory + fallback), BUKAN rekomendasi untuk
 * production — Google BISA mematikan legacy API ini kapan saja
 * (sudah deprecated sejak Juni 2024). Untuk pemakaian production
 * sungguhan, ganti implementasi ini dengan `firebase-admin` SDK resmi
 * (yang menangani OAuth2 secara otomatis) TANPA perlu mengubah
 * `PushProvider` interface maupun pemanggilnya sama sekali — itulah
 * inti dari abstraction layer ini.
 *
 * Phase 18 — lihat catatan `resilientCall` di `resend-email.provider.ts`.
 */
export const fcmPushProvider: PushProvider = {
  async send(payload: PushPayload): Promise<void> {
    const response = await resilientCall(
      'push.fcm',
      (signal) =>
        fetch('https://fcm.googleapis.com/fcm/send', {
          method: 'POST',
          headers: {
            Authorization: `key=${env.FCM_SERVER_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            to: payload.deviceToken,
            notification: { title: payload.title, body: payload.body },
            data: payload.data,
          }),
          signal,
        }),
      NOTIFICATION_PROVIDER_POLICY
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error(
        { status: response.status, body, deviceToken: payload.deviceToken },
        'FcmPushProvider: gagal mengirim push notification'
      );
      throw new Error(`FCM API mengembalikan status ${response.status}`);
    }
  },
};
