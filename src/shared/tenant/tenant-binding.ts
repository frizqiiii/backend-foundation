import type { RoleName } from '../types/role';
import { ForbiddenError } from '../utils/http-error';

/**
 * S1 — mengikat tenant yang DIPILIH lewat header `X-Tenant-ID` ke IDENTITAS yang terautentikasi.
 *
 * Masalah sebelumnya: `tenantMiddleware` menetapkan tenant aktif murni dari header, sebelum identitas diketahui, dan
 * tidak pernah membandingkannya dengan tenant milik user. Akibatnya user tenant A yang sah bisa mengirim
 * `X-Tenant-ID: B` lalu membaca/menulis data tenant B: FORCE RLS justru MENEGAKKAN pilihan header itu (RLS hanya tahu
 * `app.tenant_id`, bukan siapa pemanggilnya), jadi RLS saja tidak menutup celah ini.
 *
 * Aturan (fail-closed):
 *  1. Tanpa header (`requestedTenantId` null): tidak ada yang dibandingkan.
 *  2. Tenant terikat user/key SAMA dengan header: lolos.
 *  3. Tenant terikat null (akun platform/lama yang belum punya tenant): hanya role ADMIN yang boleh memilih tenant
 *     lewat header. Non-ADMIN tanpa tenant ditolak, supaya akun tak bertenant bukan jalan pintas ke tenant mana pun.
 *  4. Selain itu: ditolak 403.
 *
 * Fungsi murni (tanpa I/O) supaya mudah diuji penuh; pengambilan `boundTenantId` dilakukan `authMiddleware`.
 */
export function assertTenantBinding(input: {
  requestedTenantId: string | null;
  boundTenantId: string | null;
  role: RoleName;
}): void {
  const { requestedTenantId, boundTenantId, role } = input;

  if (requestedTenantId == null) {
    return;
  }
  if (boundTenantId === requestedTenantId) {
    return;
  }
  if (boundTenantId == null && role === 'ADMIN') {
    return;
  }
  throw new ForbiddenError('Anda tidak memiliki akses ke tenant yang diminta');
}
