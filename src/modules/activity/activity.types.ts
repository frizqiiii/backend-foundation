import type { ActivityType } from '@prisma/client';

export interface ActivityActorContext {
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CreateActivityLogInput extends ActivityActorContext {
  type: ActivityType;
  description: string;
  metadata?: Record<string, unknown>;
}

export type { ActivityType };
