jest.mock('../../config/database', () => ({
  prisma: { $executeRawUnsafe: jest.fn() },
}));

import { prisma } from '../../config/database';
import { databaseMaintenanceJob } from './database-maintenance.job';

const mockedExecuteRawUnsafe = prisma.$executeRawUnsafe as jest.Mock;

describe('databaseMaintenanceJob', () => {
  it('menjalankan ANALYZE untuk seluruh tabel inti ketika semuanya berhasil', async () => {
    mockedExecuteRawUnsafe.mockResolvedValue(undefined);

    const summary = await databaseMaintenanceJob.run();

    expect(mockedExecuteRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('ANALYZE'));
    expect(summary.details?.tablesAnalyzed).toBe(summary.details?.tablesTotal);
  });

  it('tetap melaporkan hasil (bukan melempar error) ketika ANALYZE gagal untuk sebagian tabel', async () => {
    mockedExecuteRawUnsafe
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('lock timeout'))
      .mockResolvedValue(undefined);

    const summary = await databaseMaintenanceJob.run();

    expect(summary.details?.tablesAnalyzed).toBeLessThan(summary.details?.tablesTotal ?? 0);
  });
});
