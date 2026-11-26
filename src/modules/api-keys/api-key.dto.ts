import { z } from 'zod';
import { getPermissionsForRole } from '../../shared/security/permissions';

// Nama permission terpanjang saat ini 19 karakter (`feature-flag.manage`); 64 memberi margin tanpa membuka pintu
// string berukuran besar (nilai yang tak dikenal tetap ditolak 403 oleh Service, tapi namanya ikut dipantulkan di pesan).
export const MAX_SCOPE_LENGTH = 64;

/**
 * `scopes` opsional — array KOSONG/tidak diisi berarti key mewarisi
 * SELURUH permission role pemiliknya saat ini (lihat
 * `ApiKeyService.create`), bukan "tidak bisa apa-apa". Kalau diisi,
 * WAJIB subset dari permission role pemiliknya — divalidasi di
 * Service, bukan di DTO ini, karena butuh tahu role si pembuat key
 * (informasi yang tidak tersedia di level Zod schema).
 */
export const createApiKeySchema = z.object({
  name: z.string().min(1, 'Nama API key wajib diisi').max(100),
  // Batas jumlah memakai `.pipe()`, BUKAN `.max()` langsung pada array berisi aturan per elemen: Zod tetap memeriksa
  // SETIAP elemen sebelum melaporkan "terlalu panjang" (body 100 KB berisi puluhan ribu elemen = puluhan ribu isu dan
  // puluhan MB heap). Dengan `.pipe()` tahap kedua dilewati begitu tahap pertama (jumlah) gagal. Batas jumlah = permission
  // terbanyak yang dimiliki satu role (ADMIN memegang seluruh daftar tertutup `Permission`).
  scopes: z
    .array(z.unknown())
    .max(getPermissionsForRole('ADMIN').length, 'Jumlah scope melebihi batas yang diizinkan')
    .pipe(z.array(z.string().max(MAX_SCOPE_LENGTH, 'Panjang scope melebihi batas yang diizinkan')))
    .optional(),
  // ISO 8601 — divalidasi lebih lanjut (harus di masa depan) di Service.
  expiresAt: z.string().datetime().optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

/**
 * Dikembalikan HANYA SEKALI, tepat setelah `POST /api-keys` — respons
 * SATU-SATUNYA titik di seluruh siklus hidup key di mana `rawKey`
 * (bentuk lengkap yang bisa dipakai untuk otentikasi) pernah terlihat.
 * Setelah ini, hanya `keyPrefix` yang tersimpan/ditampilkan — pola
 * yang sama dengan recovery code MFA (lihat `mfa.dto.ts`).
 */
export interface CreateApiKeyResponseDto {
  id: string;
  name: string;
  rawKey: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
}

export interface ApiKeySummaryDto {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/**
 * T4 — body `PATCH /api-keys/:id/rate-limit-override`. `null`
 * EKSPLISIT (bukan field dihilangkan) berarti "hapus override, pakai
 * tier plan tenant lagi" — SENGAJA `nullable()`, bukan `.optional()`,
 * supaya client harus secara sadar mengirim `null` untuk menghapus,
 * bukan sekadar lupa mengisi field.
 */
export const updateApiKeyRateLimitOverrideSchema = z.object({
  rateLimitOverridePerMinute: z
    .number()
    .int('Override kuota harus bilangan bulat')
    .positive('Override kuota harus lebih dari 0')
    .nullable(),
});
export type UpdateApiKeyRateLimitOverrideDto = z.infer<typeof updateApiKeyRateLimitOverrideSchema>;
