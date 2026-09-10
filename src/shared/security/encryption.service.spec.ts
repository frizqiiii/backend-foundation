import crypto from 'node:crypto';

describe('encryptionService', () => {
  it('encrypt lalu decrypt mengembalikan plaintext yang sama persis', () => {
    // Import dinamis DI DALAM test (bukan di top-level) supaya bisa
    // reset module registry per test dan menguji skenario rotasi key
    // yang env-nya berbeda-beda tanpa saling mempengaruhi (lihat test
    // "rotasi key" di bawah, yang butuh `ENCRYPTION_KEY_PREVIOUS`
    // berbeda dari default `jest.setup.ts`).
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encryptionService } = require('./encryption.service');

    const ciphertext = encryptionService.encrypt('secret-totp-value');

    expect(ciphertext).not.toBe('secret-totp-value');
    expect(encryptionService.decrypt(ciphertext)).toBe('secret-totp-value');
  });

  it('ciphertext berbeda setiap kali dipanggil untuk plaintext yang sama (IV acak)', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encryptionService } = require('./encryption.service');

    const a = encryptionService.encrypt('same-value');
    const b = encryptionService.encrypt('same-value');

    expect(a).not.toBe(b);
    expect(encryptionService.decrypt(a)).toBe('same-value');
    expect(encryptionService.decrypt(b)).toBe('same-value');
  });

  it('melempar error kalau ciphertext diubah (auth tag tidak cocok)', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { encryptionService } = require('./encryption.service');

    const ciphertext: string = encryptionService.encrypt('secret-totp-value');
    const [iv, authTag, data] = ciphertext.split(':');
    const tampered = [iv, authTag, Buffer.from('tampered').toString('base64')].join(':');
    void data;

    expect(() => encryptionService.decrypt(tampered)).toThrow();
  });

  it('bisa mendekripsi data lama pakai ENCRYPTION_KEY_PREVIOUS setelah rotasi key', () => {
    const originalKey = process.env.ENCRYPTION_KEY;
    const originalPreviousKey = process.env.ENCRYPTION_KEY_PREVIOUS;

    try {
      // 1. Enkripsi dengan key "lama"
      const oldKey = crypto.randomBytes(32).toString('base64');
      process.env.ENCRYPTION_KEY = oldKey;
      process.env.ENCRYPTION_KEY_PREVIOUS = '';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const withOldKey = require('./encryption.service').encryptionService;
      const ciphertext = withOldKey.encrypt('secret-totp-value');

      // 2. "Rotasi" — key baru jadi aktif, key lama dipindah ke PREVIOUS
      const newKey = crypto.randomBytes(32).toString('base64');
      process.env.ENCRYPTION_KEY = newKey;
      process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const withRotatedKeys = require('./encryption.service').encryptionService;

      // 3. Data lama (dienkripsi dengan key lama) TETAP bisa didekripsi
      expect(withRotatedKeys.decrypt(ciphertext)).toBe('secret-totp-value');
    } finally {
      process.env.ENCRYPTION_KEY = originalKey;
      process.env.ENCRYPTION_KEY_PREVIOUS = originalPreviousKey;
      jest.resetModules();
    }
  });
});
