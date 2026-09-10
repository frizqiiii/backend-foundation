import type { AnalyticsRepository } from './analytics.repository';
import type { DailyActiveUsersDto } from './analytics.dto';
import { BadRequestError } from '../../shared/utils/http-error';

const MIN_DAYS = 1;
// 90 hari (bukan lebih) — `generate_series` + `date_trunc` di
// `AnalyticsRepository.dailyActiveUsers` sudah cukup murah untuk
// rentang ini; membiarkan `days` tak terbatas membuka celah DoS
// ringan lewat query range yang sangat besar (mis. `?days=100000`).
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

export class AnalyticsService {
  constructor(private readonly analyticsRepository: AnalyticsRepository) {}

  async getDailyActiveUsers(days: number = DEFAULT_DAYS): Promise<DailyActiveUsersDto> {
    if (!Number.isInteger(days) || days < MIN_DAYS || days > MAX_DAYS) {
      throw new BadRequestError(`days harus berupa bilangan bulat antara ${MIN_DAYS}-${MAX_DAYS}`);
    }

    const data = await this.analyticsRepository.dailyActiveUsers(days);
    return { days, data };
  }
}
