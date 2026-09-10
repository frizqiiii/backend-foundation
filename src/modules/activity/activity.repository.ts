import type { PrismaClient, ActivityLog, Prisma } from '@prisma/client';
import type { CreateActivityLogInput } from './activity.types';

export class ActivityRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: CreateActivityLogInput): Promise<ActivityLog> {
    return this.prisma.activityLog.create({
      data: {
        ...data,
        // `metadata` bertipe `Record<string, unknown> | undefined` di
        // level Service (lebih nyaman dipakai pemanggil), di-cast ke
        // `Prisma.InputJsonValue` HANYA di titik masuk Prisma ini —
        // satu-satunya tempat yang perlu tahu detail tipe Json Prisma.
        metadata: data.metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
