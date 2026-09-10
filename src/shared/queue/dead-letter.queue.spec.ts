describe('dead-letter.queue', () => {
  const queueAdd = jest.fn();
  const loggerWarn = jest.fn();

  async function loadWithConnection(connection: unknown) {
    let mod: typeof import('./dead-letter.queue') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('bullmq', () => ({
        Queue: jest.fn().mockImplementation(() => ({ add: queueAdd })),
      }));
      jest.doMock('./connection', () => ({ queueConnection: connection }));
      jest.doMock('../logger', () => ({ logger: { warn: loggerWarn } }));
      jest.doMock('../observability/bullmq-telemetry', () => ({ bullMQTelemetry: null }));
      mod = require('./dead-letter.queue');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deadLetterQueue bernilai null kalau queueConnection null (perilaku default lingkungan test)', async () => {
    const realMod = await import('./dead-letter.queue');
    expect(realMod.deadLetterQueue).toBeNull();
  });

  describe('moveToDeadLetter', () => {
    it('P5 — tidak melakukan apa pun kalau deadLetterQueue null (Redis tidak dikonfigurasi)', async () => {
      const { moveToDeadLetter } = await loadWithConnection(null);

      await moveToDeadLetter({
        queue: 'email',
        jobName: 'verification',
        data: {},
        failedReason: 'x',
        attemptsMade: 3,
      });

      expect(queueAdd).not.toHaveBeenCalled();
    });

    it('menambahkan job ke dead-letter queue dengan payload lengkap', async () => {
      queueAdd.mockResolvedValue({});
      const { moveToDeadLetter } = await loadWithConnection({});
      const payload = {
        queue: 'email',
        jobName: 'verification',
        data: { to: 'budi@example.com' },
        failedReason: 'SMTP timeout',
        attemptsMade: 5,
      };

      await moveToDeadLetter(payload);

      expect(queueAdd).toHaveBeenCalledWith('dead-letter', payload);
    });

    it('P5 — kegagalan menulis ke dead-letter queue di-log sebagai warning, TIDAK melempar error', async () => {
      queueAdd.mockRejectedValue(new Error('Redis timeout'));
      const { moveToDeadLetter } = await loadWithConnection({});

      await expect(
        moveToDeadLetter({
          queue: 'email',
          jobName: 'verification',
          data: {},
          failedReason: 'x',
          attemptsMade: 3,
        })
      ).resolves.toBeUndefined();

      expect(loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ originalQueue: 'email', jobName: 'verification' }),
        expect.stringContaining('gagal mencatat')
      );
    });
  });
});
