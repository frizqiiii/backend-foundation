/**
 * SMS Provider (Phase 15 — Enterprise Integration). Sama pola dengan
 * `email.provider.ts` — lihat komentar lengkap di sana.
 */
export interface SmsPayload {
  to: string;
  message: string;
}

export interface SmsProvider {
  send(payload: SmsPayload): Promise<void>;
}
