/**
 * Catatan konsolidasi (#2 — Auth): `registerUserSchema`, `loginSchema`,
 * dan `LoginResponseDto` yang sebelumnya ada di file ini SUDAH
 * DIPINDAH ke `modules/auth/auth.dto.ts` — tanggung jawab autentikasi
 * (register/login/token) kini sepenuhnya milik modul `auth`. Modul
 * `users` hanya menyisakan bentuk data profil (`UserResponseDto`),
 * yang tetap dipakai bersama oleh `users` (endpoint `/me`) maupun
 * `auth` (response setelah register/login).
 */
import { z } from 'zod';

export interface UserResponseDto {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

/**
 * Skema query string untuk `GET /users` (Phase 3) — pola pagination
 * yang identik dengan `listEventsQuerySchema`/`listProductsQuerySchema`,
 * MENGGANTIKAN `findAll()` lama yang mengambil seluruh baris tanpa
 * batas sama sekali.
 */
export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListUsersQueryDto = z.infer<typeof listUsersQuerySchema>;
