import { signWebhookPayload, verifyWebhookSignature, isTimestampFresh } from './webhook-signer';

const T = 1_700_000_000; // timestamp Unix tetap, dipakai di seluruh test supaya deterministik

describe('webhook-signer', () => {
  it('signWebhookPayload menghasilkan format sha256=<hex>', () => {
    const signature = signWebhookPayload('{"event":"test"}', 'secret-abc', T);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('signature yang sama untuk payload+secret+timestamp yang sama (deterministik)', () => {
    const a = signWebhookPayload('{"x":1}', 'secret-abc', T);
    const b = signWebhookPayload('{"x":1}', 'secret-abc', T);
    expect(a).toBe(b);
  });

  it('signature berbeda untuk payload berbeda', () => {
    const a = signWebhookPayload('{"x":1}', 'secret-abc', T);
    const b = signWebhookPayload('{"x":2}', 'secret-abc', T);
    expect(a).not.toBe(b);
  });

  it('signature berbeda untuk secret berbeda', () => {
    const a = signWebhookPayload('{"x":1}', 'secret-abc', T);
    const b = signWebhookPayload('{"x":1}', 'secret-xyz', T);
    expect(a).not.toBe(b);
  });

  it('signature berbeda untuk timestamp berbeda (Finding #22 — timestamp ikut ditandatangani, bukan sekadar header polos)', () => {
    const a = signWebhookPayload('{"x":1}', 'secret-abc', T);
    const b = signWebhookPayload('{"x":1}', 'secret-abc', T + 1);
    expect(a).not.toBe(b);
  });

  describe('verifyWebhookSignature', () => {
    it('mengembalikan true untuk signature yang valid', () => {
      const payload = '{"event":"product.created"}';
      const secret = 'secret-abc';
      const signature = signWebhookPayload(payload, secret, T);

      expect(verifyWebhookSignature(payload, secret, T, signature)).toBe(true);
    });

    it('mengembalikan false kalau payload diubah setelah ditandatangani', () => {
      const secret = 'secret-abc';
      const signature = signWebhookPayload('{"event":"product.created"}', secret, T);

      expect(verifyWebhookSignature('{"event":"product.deleted"}', secret, T, signature)).toBe(
        false
      );
    });

    it('mengembalikan false untuk secret yang salah', () => {
      const payload = '{"event":"product.created"}';
      const signature = signWebhookPayload(payload, 'secret-abc', T);

      expect(verifyWebhookSignature(payload, 'wrong-secret', T, signature)).toBe(false);
    });

    it('mengembalikan false kalau timestamp yang diverifikasi BEDA dari yang ditandatangani (Finding #22 — mencegah penyerang asal comot timestamp baru untuk signature lama)', () => {
      const payload = '{"event":"product.created"}';
      const secret = 'secret-abc';
      const signature = signWebhookPayload(payload, secret, T);

      expect(verifyWebhookSignature(payload, secret, T + 1, signature)).toBe(false);
    });

    it('mengembalikan false (bukan melempar error) untuk signature dengan panjang berbeda', () => {
      expect(verifyWebhookSignature('{"x":1}', 'secret', T, 'sha256=short')).toBe(false);
    });
  });

  describe('isTimestampFresh (Finding #22 — replay protection)', () => {
    it('mengembalikan true untuk timestamp yang persis sama dengan sekarang', () => {
      expect(isTimestampFresh(T, T)).toBe(true);
    });

    it('mengembalikan true untuk timestamp dalam toleransi default (< 5 menit)', () => {
      expect(isTimestampFresh(T, T + 4 * 60)).toBe(true);
      expect(isTimestampFresh(T, T - 4 * 60)).toBe(true);
    });

    it('mengembalikan false untuk timestamp di luar toleransi default (> 5 menit) — baik LAMA (replay) maupun MASA DEPAN (jam salah satu pihak keliru)', () => {
      expect(isTimestampFresh(T, T + 6 * 60)).toBe(false);
      expect(isTimestampFresh(T, T - 6 * 60)).toBe(false);
    });

    it('menghormati toleransi kustom ketika diberikan', () => {
      expect(isTimestampFresh(T, T + 30, 10)).toBe(false);
      expect(isTimestampFresh(T, T + 5, 10)).toBe(true);
    });
  });
});
