import { z } from 'zod';

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
