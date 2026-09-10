import { mailer } from '../utils/mailer';

jest.mock('../utils/mailer', () => ({
  mailer: { send: jest.fn() },
}));

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue(undefined) })),
}));

const mockedMailer = mailer as jest.Mocked<typeof mailer>;

describe('email.queue', () => {
  describe('ketika Redis TIDAK dikonfigurasi (queueConnection null)', () => {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    let enqueueEmailJob: typeof import('./email.queue').enqueueEmailJob;

    beforeAll(async () => {
      // `jest.isolateModules` dipakai supaya modul `connection.ts` yang
      // di-import ULANG di sini benar-benar mengevaluasi ulang
      // `env.REDIS_URL` (kosong secara default di `jest.setup.ts`),
      // menghasilkan `queueConnection: null` — jalur "Redis tidak
      // dikonfigurasi" yang ingin diuji di sini.
      await jest.isolateModulesAsync(async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports
        const mod = require('./email.queue') as typeof import('./email.queue');
        enqueueEmailJob = mod.enqueueEmailJob;
        expect(mod.emailQueue).toBeNull();
      });
    });

    it('fallback ke eksekusi sinkron (memanggil mailer langsung) ketika enqueueEmailJob dipanggil', async () => {
      await enqueueEmailJob({ type: 'verification', to: 'budi@example.com', token: 'abc123' });

      expect(mockedMailer.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'budi@example.com',
          subject: expect.stringContaining('Verifikasi'),
        })
      );
    });

    it('mengirim subject "Reset Password" untuk job bertipe password-reset', async () => {
      await enqueueEmailJob({ type: 'password-reset', to: 'budi@example.com', token: 'xyz789' });

      expect(mockedMailer.send).toHaveBeenCalledWith(
        expect.objectContaining({ subject: expect.stringContaining('Reset Password') })
      );
    });
  });

  describe('ketika Redis DIKONFIGURASI (queueConnection tersedia)', () => {
    it('memasukkan job ke antrian BullMQ, TIDAK memanggil mailer secara langsung', async () => {
      await jest.isolateModulesAsync(async () => {
        // Mock `connection.ts` langsung (bukan set REDIS_URL sungguhan)
        // — menghindari ioredis benar-benar mencoba konek ke jaringan;
        // yang diuji di sini murni LOGIKA percabangan queue vs sync,
        // bukan konektivitas Redis itu sendiri.
        jest.doMock('./connection', () => ({ queueConnection: {} }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports
        const mailerMod = require('../utils/mailer') as typeof import('../utils/mailer');
        // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/consistent-type-imports
        const mod = require('./email.queue') as typeof import('./email.queue');

        expect(mod.emailQueue).not.toBeNull();

        await mod.enqueueEmailJob({
          type: 'verification',
          to: 'budi@example.com',
          token: 'abc123',
        });

        expect(mod.emailQueue?.add).toHaveBeenCalledWith('verification', {
          type: 'verification',
          to: 'budi@example.com',
          token: 'abc123',
        });
        expect(mailerMod.mailer.send).not.toHaveBeenCalled();
      });
    });
  });
});
