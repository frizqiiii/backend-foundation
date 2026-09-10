/**
 * Push Notification Provider (Phase 15 — Enterprise Integration).
 * Sama pola dengan `email.provider.ts`/`sms.provider.ts`.
 */
export interface PushPayload {
  /** Device/registration token tujuan — SATU token per panggilan
   * `send`; pemanggil yang butuh broadcast ke banyak device
   * memanggil ini berkali-kali (lihat catatan batching di
   * `fcm-push.provider.ts`). */
  deviceToken: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushProvider {
  send(payload: PushPayload): Promise<void>;
}
