import { AnalyticsService } from './analytics.service';
import type { AnalyticsRepository } from './analytics.repository';
import { BadRequestError } from '../../shared/utils/http-error';

describe('AnalyticsService', () => {
  let analyticsRepository: jest.Mocked<AnalyticsRepository>;
  let analyticsService: AnalyticsService;

  beforeEach(() => {
    analyticsRepository = {
      dailyActiveUsers: jest.fn(),
    } as unknown as jest.Mocked<AnalyticsRepository>;

    analyticsService = new AnalyticsService(analyticsRepository);
  });

  describe('getDailyActiveUsers', () => {
    it('meneruskan default 30 hari ketika `days` tidak diberikan', async () => {
      analyticsRepository.dailyActiveUsers.mockResolvedValue([
        { date: '2026-08-05', count: 4 },
        { date: '2026-08-06', count: 7 },
      ]);

      const result = await analyticsService.getDailyActiveUsers();

      expect(analyticsRepository.dailyActiveUsers).toHaveBeenCalledWith(30);
      expect(result).toEqual({
        days: 30,
        data: [
          { date: '2026-08-05', count: 4 },
          { date: '2026-08-06', count: 7 },
        ],
      });
    });

    it('meneruskan `days` kustom ke repository', async () => {
      analyticsRepository.dailyActiveUsers.mockResolvedValue([]);

      await analyticsService.getDailyActiveUsers(7);

      expect(analyticsRepository.dailyActiveUsers).toHaveBeenCalledWith(7);
    });

    it('menolak `days` di luar rentang 1-90 dengan BadRequestError', async () => {
      await expect(analyticsService.getDailyActiveUsers(0)).rejects.toThrow(BadRequestError);
      await expect(analyticsService.getDailyActiveUsers(91)).rejects.toThrow(BadRequestError);
      expect(analyticsRepository.dailyActiveUsers).not.toHaveBeenCalled();
    });

    it('menolak `days` non-integer', async () => {
      await expect(analyticsService.getDailyActiveUsers(1.5)).rejects.toThrow(BadRequestError);
    });
  });
});
