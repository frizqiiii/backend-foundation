import { logger } from '../../logger';
import type { EmailProvider, EmailPayload } from './email.provider';

/**
 * Implementasi DEFAULT — mencatat ke log, TIDAK benar-benar mengirim
 * email ke mana pun. Ini bukan simulasi/pretend feature: dipakai
 * SENGAJA di development/test, dan sebagai fallback aman kalau
 * provider sungguhan dipilih (`EMAIL_PROVIDER=resend`) TAPI
 * kredensialnya belum diisi (lihat `index.ts`).
 */
export const logEmailProvider: EmailProvider = {
  async send(payload: EmailPayload): Promise<void> {
    logger.warn(
      { to: payload.to, subject: payload.subject },
      '[EMAIL PROVIDER: log — EMAIL TIDAK BENAR-BENAR DIKIRIM]'
    );
  },
};
