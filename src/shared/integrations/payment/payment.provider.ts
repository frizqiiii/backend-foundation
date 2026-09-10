/**
 * Payment Provider (Phase 15 — Enterprise Integration). Sama pola
 * dengan provider lain di fase ini.
 *
 * SENGAJA HANYA mencakup `createPaymentIntent` (memulai satu
 * transaksi) di iterasi ini — refund/webhook-signature-verification/
 * capture-terpisah adalah kapabilitas lanjutan yang ditambahkan ke
 * interface ini saat benar-benar dibutuhkan pemanggil sungguhan,
 * bukan dibuat spekulatif sebelum ada use case.
 */
export interface CreatePaymentIntentInput {
  /** Nominal dalam UNIT TERKECIL mata uang (mis. sen untuk USD, PADA
   * IDR — yang tidak punya sub-unit — nilai ini sama dengan Rupiah
   * penuh). Konvensi ini SENGAJA mengikuti konvensi Stripe supaya
   * tidak ada konversi tersembunyi antara interface ini dan
   * implementasi Stripe-nya. */
  amount: number;
  currency: string;
  description?: string;
}

export interface PaymentIntentResult {
  id: string;
  status: string;
  clientSecret?: string;
}

export interface PaymentProvider {
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentResult>;
}
