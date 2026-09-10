import { resendEmailProvider } from './resend-email.provider';

describe('resendEmailProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('mengirim POST ke Resend API dengan Authorization Bearer & body yang benar', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch as never;

    await resendEmailProvider.send({
      to: 'budi@example.com',
      subject: 'Verifikasi email',
      text: 'Klik link ini',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Bearer'),
        }),
      })
    );
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.to).toBe('budi@example.com');
    expect(body.subject).toBe('Verifikasi email');
  });

  it('melempar error kalau Resend API mengembalikan status bukan 2xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }) as never;

    await expect(
      resendEmailProvider.send({ to: 'budi@example.com', subject: 'x', text: 'y' })
    ).rejects.toThrow('401');
  });
});
