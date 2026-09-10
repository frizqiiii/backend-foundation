import { mailer } from './mailer';
import { emailProvider } from '../integrations/email';

jest.mock('../integrations/email', () => ({ emailProvider: { send: jest.fn() } }));

describe('mailer', () => {
  it('mendelegasikan send() sepenuhnya ke emailProvider yang aktif', async () => {
    const payload = { to: 'budi@example.com', subject: 'Halo', text: 'Isi email' };

    await mailer.send(payload);

    expect(emailProvider.send).toHaveBeenCalledWith(payload);
  });
});
