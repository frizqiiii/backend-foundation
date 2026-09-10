/**
 * Email Provider (Phase 15 — Enterprise Integration).
 *
 * Interface ini adalah SATU-SATUNYA kontrak yang boleh diketahui
 * pemanggil (`AuthService`, dst, lewat `shared/utils/mailer.ts`) —
 * TIDAK ADA kode di luar folder ini yang boleh tahu provider mana
 * yang sedang aktif atau detail API vendor tertentu. Menambah
 * provider baru (mis. AWS SES, Mailgun) berarti menambah SATU file
 * implementasi baru di folder ini + satu baris di `index.ts`, TIDAK
 * PERNAH menyentuh pemanggil.
 */
export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(payload: EmailPayload): Promise<void>;
}
