import { logPushProvider } from './log-push.provider';
import { logger } from '../../logger';

jest.mock('../../logger', () => ({ logger: { warn: jest.fn() } }));

describe('logPushProvider', () => {
  it('mencatat ke logger.warn dengan deviceToken/title, TIDAK benar-benar mengirim apa pun', async () => {
    await logPushProvider.send({ deviceToken: 'token-abc', title: 'Halo', body: 'Isi notifikasi' });

    expect(logger.warn).toHaveBeenCalledWith(
      { deviceToken: 'token-abc', title: 'Halo' },
      expect.stringContaining('TIDAK BENAR-BENAR DIKIRIM')
    );
  });
});
