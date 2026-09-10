import { authenticator } from 'otplib';
import { MfaService } from './mfa.service';
import type { MfaRepository } from './mfa.repository';
import { encryptionService } from '../../shared/security/encryption.service';
import { BadRequestError, UnauthorizedError } from '../../shared/utils/http-error';

describe('MfaService', () => {
  let mfaRepository: jest.Mocked<MfaRepository>;
  let mfaService: MfaService;

  const baseUser = {
    id: 'user-1',
    email: 'budi@example.com',
  };

  beforeEach(() => {
    mfaRepository = {
      setPendingSecret: jest.fn(),
      activateMfa: jest.fn(),
      disableMfa: jest.fn(),
      replaceRecoveryCodes: jest.fn(),
      findUnusedRecoveryCodes: jest.fn(),
      markRecoveryCodeUsed: jest.fn(),
    } as unknown as jest.Mocked<MfaRepository>;

    mfaService = new MfaService(mfaRepository);
  });

  describe('beginSetup', () => {
    it('menghasilkan secret baru, MENYIMPANNYA TERENKRIPSI, dan mengembalikan otpauthUrl', async () => {
      const result = await mfaService.beginSetup(baseUser);

      expect(result.secret).toHaveLength(32); // otplib default secret length
      expect(result.otpauthUrl).toContain('otpauth://totp/');
      expect(result.otpauthUrl).toContain(encodeURIComponent(baseUser.email));

      const [, encryptedSecret] = mfaRepository.setPendingSecret.mock.calls[0];
      // Yang disimpan ke database HARUS ciphertext, bukan secret mentah.
      expect(encryptedSecret).not.toBe(result.secret);
      expect(encryptionService.decrypt(encryptedSecret)).toBe(result.secret);

      // `mfaEnabled` TIDAK BOLEH diaktifkan di langkah ini — lihat
      // komentar "dua langkah" di MfaService.beginSetup.
      expect(mfaRepository.activateMfa).not.toHaveBeenCalled();
    });
  });

  describe('confirmSetup', () => {
    it('melempar BadRequestError kalau belum ada setup MFA yang berjalan (mfaSecret kosong)', async () => {
      const user = { ...baseUser, mfaSecret: null } as never;

      await expect(mfaService.confirmSetup(user, '123456')).rejects.toThrow(BadRequestError);
      expect(mfaRepository.activateMfa).not.toHaveBeenCalled();
    });

    it('melempar UnauthorizedError kalau kode TOTP tidak cocok dengan secret pending', async () => {
      const secret = authenticator.generateSecret();
      const user = { ...baseUser, mfaSecret: encryptionService.encrypt(secret) } as never;

      await expect(mfaService.confirmSetup(user, '000000')).rejects.toThrow(UnauthorizedError);
      expect(mfaRepository.activateMfa).not.toHaveBeenCalled();
    });

    it('mengaktifkan MFA & menerbitkan 8 recovery code kalau kode TOTP cocok', async () => {
      const secret = authenticator.generateSecret();
      const user = { ...baseUser, mfaSecret: encryptionService.encrypt(secret) } as never;
      const validCode = authenticator.generate(secret);

      const recoveryCodes = await mfaService.confirmSetup(user, validCode);

      expect(recoveryCodes).toHaveLength(8);
      // Format XXXXX-XXXXX, hex uppercase.
      recoveryCodes.forEach((code) => expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/));
      // Semua kode harus unik.
      expect(new Set(recoveryCodes).size).toBe(8);

      expect(mfaRepository.replaceRecoveryCodes).toHaveBeenCalledWith(
        baseUser.id,
        expect.arrayContaining([expect.any(String)])
      );
      expect(mfaRepository.activateMfa).toHaveBeenCalledWith(baseUser.id);
    });
  });

  describe('verifyCode', () => {
    it('mengembalikan false kalau user belum pernah setup MFA (mfaSecret null)', async () => {
      const result = await mfaService.verifyCode(
        { ...baseUser, mfaSecret: null } as never,
        '123456'
      );
      expect(result).toBe(false);
    });

    it('mengembalikan true untuk kode TOTP yang valid', async () => {
      const secret = authenticator.generateSecret();
      const user = { ...baseUser, mfaSecret: encryptionService.encrypt(secret) } as never;
      const validCode = authenticator.generate(secret);

      expect(await mfaService.verifyCode(user, validCode)).toBe(true);
    });

    it('fallback ke recovery code dan menandainya terpakai kalau kode TOTP tidak cocok', async () => {
      const secret = authenticator.generateSecret();
      const user = { ...baseUser, mfaSecret: encryptionService.encrypt(secret) } as never;

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const bcrypt = require('bcrypt');
      mfaRepository.findUnusedRecoveryCodes.mockResolvedValue([
        {
          id: 'code-1',
          userId: baseUser.id,
          codeHash: await bcrypt.hash('ABCDE-12345', 4),
          usedAt: null,
          createdAt: new Date(),
        },
      ]);

      const result = await mfaService.verifyCode(user, 'ABCDE-12345');

      expect(result).toBe(true);
      expect(mfaRepository.markRecoveryCodeUsed).toHaveBeenCalledWith('code-1');
    });

    it('mengembalikan false kalau kode TOTP dan recovery code SAMA SEKALI tidak cocok', async () => {
      const secret = authenticator.generateSecret();
      const user = { ...baseUser, mfaSecret: encryptionService.encrypt(secret) } as never;
      mfaRepository.findUnusedRecoveryCodes.mockResolvedValue([]);

      expect(await mfaService.verifyCode(user, '000000')).toBe(false);
      expect(mfaRepository.markRecoveryCodeUsed).not.toHaveBeenCalled();
    });
  });

  describe('disable', () => {
    it('mendelegasikan ke mfaRepository.disableMfa', async () => {
      await mfaService.disable(baseUser);
      expect(mfaRepository.disableMfa).toHaveBeenCalledWith(baseUser.id);
    });
  });
});
