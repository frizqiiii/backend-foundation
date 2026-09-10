import { logEmailProvider } from './log-email.provider';
import { logger } from '../../logger';

jest.mock('../../logger', () => ({ logger: { warn: jest.fn() } }));

describe('logEmailProvider', () => {
  it('mencatat ke logger.warn dengan to/subject, TIDAK benar-benar mengirim apa pun', async () => {
    await logEmailProvider.send({ to: 'budi@example.com', subject: 'Halo', text: 'Isi email' });

    expect(logger.warn).toHaveBeenCalledWith(
      { to: 'budi@example.com', subject: 'Halo' },
      expect.stringContaining('TIDAK BENAR-BENAR DIKIRIM')
    );
  });
});
