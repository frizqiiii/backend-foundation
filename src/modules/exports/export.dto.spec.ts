import { createExportRequestSchema } from './export.dto';

describe('createExportRequestSchema', () => {
  it.each([
    'USERS',
    'AUDIT_LOG',
    'DASHBOARD_STATS',
    'USER_STATISTICS',
    'EVENT_STATISTICS',
    'PRODUCT_STATISTICS',
    'SYSTEM_STATISTICS',
    'DAILY_ACTIVE_USERS',
  ])('menerima type: %s dengan format CSV', (type) => {
    const result = createExportRequestSchema.safeParse({ type, format: 'CSV' });
    expect(result.success).toBe(true);
  });

  it.each(['CSV', 'XLSX', 'PDF'])('menerima format: %s', (format) => {
    const result = createExportRequestSchema.safeParse({ type: 'USERS', format });
    expect(result.success).toBe(true);
  });

  it('menolak type yang tidak dikenal', () => {
    expect(
      createExportRequestSchema.safeParse({ type: 'UNKNOWN_TYPE', format: 'CSV' }).success
    ).toBe(false);
  });

  it('menolak format yang tidak dikenal', () => {
    expect(createExportRequestSchema.safeParse({ type: 'USERS', format: 'DOCX' }).success).toBe(
      false
    );
  });

  it('menolak kalau type atau format tidak diisi', () => {
    expect(createExportRequestSchema.safeParse({ type: 'USERS' }).success).toBe(false);
    expect(createExportRequestSchema.safeParse({ format: 'CSV' }).success).toBe(false);
  });
});
