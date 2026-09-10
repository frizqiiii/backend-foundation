import type { PrismaClient } from '@prisma/client';
import { AnalyticsRepository } from './analytics.repository';

describe('AnalyticsRepository', () => {
  describe('dailyActiveUsers', () => {
    it('memetakan hasil $queryRaw (Date + bigint) ke {date: string YYYY-MM-DD, count: number}', async () => {
      const queryRaw = jest.fn().mockResolvedValue([
        { date: new Date('2026-09-01T00:00:00.000Z'), count: BigInt(3) },
        { date: new Date('2026-09-02T00:00:00.000Z'), count: BigInt(0) },
      ]);
      const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
      const repository = new AnalyticsRepository(prisma);

      const result = await repository.dailyActiveUsers(7);

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { date: '2026-09-01', count: 3 },
        { date: '2026-09-02', count: 0 },
      ]);
    });

    it('mengembalikan array kosong kalau tidak ada baris sama sekali', async () => {
      const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) } as unknown as PrismaClient;
      const repository = new AnalyticsRepository(prisma);

      const result = await repository.dailyActiveUsers(30);

      expect(result).toEqual([]);
    });
  });
});
