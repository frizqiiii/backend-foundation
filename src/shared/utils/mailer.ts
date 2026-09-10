import { emailProvider } from '../integrations/email';
import type { EmailPayload } from '../integrations/email';

export type MailPayload = EmailPayload;

/**
 * Titik masuk email yang dipakai pemanggil di seluruh aplikasi
 * (`AuthService`, `shared/queue/email.queue.ts`) — TETAP ADA di lokasi
 * ini dan bentuknya TIDAK BERUBAH (Phase 15) demi backward
 * compatibility, TAPI implementasinya sekarang didelegasikan ke
 * `shared/integrations/email/` (abstraction layer provider). Ganti
 * provider lewat `EMAIL_PROVIDER` di env, BUKAN dengan mengedit file
 * ini — lihat `shared/integrations/email/index.ts`.
 */
export const mailer = {
  async send(payload: MailPayload): Promise<void> {
    await emailProvider.send(payload);
  },
};
