import { logger } from '../../shared/logger';
import type { ActivityRepository } from './activity.repository';
import type { ActivityActorContext } from './activity.types';

/**
 * Service Layer untuk modul Activity — prinsip "tidak pernah
 * menggagalkan request utama" yang SAMA seperti `AuditService`. Lihat
 * komentar di `audit.service.ts` untuk alasan lengkapnya; tidak
 * diulang di sini supaya tidak duplikasi penjelasan yang sama persis.
 */
export class ActivityService {
  constructor(private readonly activityRepository: ActivityRepository) {}

  private async record(
    type: 'USER_ACTIVITY' | 'FILE_UPLOAD' | 'AUTH_ACTIVITY',
    description: string,
    actor: ActivityActorContext,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.activityRepository.create({ ...actor, type, description, metadata });
    } catch (error) {
      logger.warn(
        { err: error, type, description, userId: actor.userId },
        'ActivityService: gagal mencatat activity log — request utama tetap dilanjutkan'
      );
    }
  }

  async logUserActivity(
    description: string,
    actor: ActivityActorContext,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.record('USER_ACTIVITY', description, actor, metadata);
  }

  async logFileUpload(
    description: string,
    actor: ActivityActorContext,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.record('FILE_UPLOAD', description, actor, metadata);
  }

  async logAuthActivity(
    description: string,
    actor: ActivityActorContext,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.record('AUTH_ACTIVITY', description, actor, metadata);
  }
}
