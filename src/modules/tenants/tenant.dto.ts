import { z } from 'zod';

/**
 * Fase 2 (item 2.11) — HARUS identik dengan `enum TenantPlan` di
 * `schema.prisma` dan `TenantPlanName` di `rate-limit-tiers.ts`.
 */
export const tenantPlanSchema = z.enum(['FREE', 'PRO', 'ENTERPRISE']);

/**
 * `slug` dibatasi ke karakter yang aman dipakai di header/subdomain —
 * huruf kecil, angka, dan tanda hubung. Konsisten dengan asumsi
 * `TENANT_HEADER_NAME`/`tenantMiddleware` bahwa slug adalah token
 * yang "aman diketik manusia", bukan string bebas.
 */
export const createTenantSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Slug hanya boleh huruf kecil, angka, dan tanda hubung'),
  name: z.string().min(1).max(200),
  // Opsional — tidak diisi = default database (`PRO`, sama dengan
  // perilaku flat sebelum item 2.11). Lihat komentar di `schema.prisma`.
  plan: tenantPlanSchema.optional(),
});

export type CreateTenantDto = z.infer<typeof createTenantSchema>;

/**
 * P3 (Database Audit) — pola identik dengan `listUsersQuerySchema`/
 * `listEventsQuerySchema`/`listProductsQuerySchema`.
 */
export const listTenantsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListTenantsQueryDto = z.infer<typeof listTenantsQuerySchema>;

/**
 * Fase 2 (item 2.11) — body `PATCH /tenants/:id/plan`. SENGAJA hanya
 * `plan` (bukan update tenant generik) — lihat `TenantRepository.updatePlan`.
 */
export const updateTenantPlanSchema = z.object({
  plan: tenantPlanSchema,
});

export type UpdateTenantPlanDto = z.infer<typeof updateTenantPlanSchema>;

/**
 * T3 — HARUS identik dengan `enum TenantStatus` di `schema.prisma`.
 */
export const tenantStatusSchema = z.enum(['ACTIVE', 'SUSPENDED']);

/**
 * T3 — body `PATCH /tenants/:id/status`. Pola sama dengan
 * `updateTenantPlanSchema` di atas.
 */
export const updateTenantStatusSchema = z.object({
  status: tenantStatusSchema,
});

export type UpdateTenantStatusDto = z.infer<typeof updateTenantStatusSchema>;
