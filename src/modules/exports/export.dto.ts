import { z } from 'zod';

export const createExportRequestSchema = z.object({
  type: z.enum([
    'USERS',
    'AUDIT_LOG',
    'DASHBOARD_STATS',
    'USER_STATISTICS',
    'EVENT_STATISTICS',
    'PRODUCT_STATISTICS',
    'SYSTEM_STATISTICS',
    'DAILY_ACTIVE_USERS',
  ]),
  format: z.enum(['CSV', 'XLSX', 'PDF']),
});
export type CreateExportRequestDto = z.infer<typeof createExportRequestSchema>;

export interface ExportJobResponseDto {
  id: string;
  type: string;
  format: string;
  status: string;
  fileUrl: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}
