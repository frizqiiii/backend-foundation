jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
}));

describe('notification.queue', () => {
  describe('ketika Redis TIDAK dikonfigurasi (queueConnection null)', () => {
    it('fallback ke eksekusi sinkron (log langsung) tanpa error', async () => {
      await jest.isolateModulesAsync(async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports
        const mod = require('./notification.queue') as typeof import('./notification.queue');
        expect(mod.notificationQueue).toBeNull();

        await expect(
          mod.enqueueNotificationJob({ userId: 'user-123', message: 'Event Anda diubah admin' })
        ).resolves.toBeUndefined();
      });
    });
  });

  describe('ketika Redis DIKONFIGURASI (queueConnection tersedia)', () => {
    it('memasukkan job ke antrian BullMQ', async () => {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./connection', () => ({ queueConnection: {} }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports
        const mod = require('./notification.queue') as typeof import('./notification.queue');
        expect(mod.notificationQueue).not.toBeNull();

        await mod.enqueueNotificationJob({
          userId: 'user-123',
          message: 'Event Anda diubah admin',
        });

        expect(mod.notificationQueue?.add).toHaveBeenCalledWith('notify', {
          userId: 'user-123',
          message: 'Event Anda diubah admin',
        });
      });
    });
  });
});
