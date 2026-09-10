import { logSmsProvider } from './log-sms.provider';
import { logger } from '../../logger';

jest.mock('../../logger', () => ({ logger: { warn: jest.fn() } }));

describe('logSmsProvider', () => {
  it('mencatat ke logger.warn dengan nomor tujuan, TIDAK benar-benar mengirim apa pun', async () => {
    await logSmsProvider.send({ to: '+6281234567890', message: 'Kode OTP: 123456' });

    expect(logger.warn).toHaveBeenCalledWith(
      { to: '+6281234567890' },
      expect.stringContaining('TIDAK BENAR-BENAR DIKIRIM')
    );
  });
});
