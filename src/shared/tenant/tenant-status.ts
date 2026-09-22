import { prisma } from '../config/database';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { TenantService } from '../../modules/tenants/tenant.service';

// Instance module-level — pola & alasan sama dengan
// `tenant-plan.ts`/`tenant.middleware.ts` (lihat komentar di sana):
// tidak diimpor dari `modules/tenants/tenant.routes.ts` supaya arah
// dependency tetap `modules/* -> shared/*`, bukan sebaliknya.
const tenantService = new TenantService(new TenantRepository(prisma));

/**
 * T3 — dipakai `authenticateWithApiKey` untuk menegakkan status
 * tenant di jalur API key, yang SEBELUM temuan ini tidak pernah
 * mengecek status sama sekali (hanya `tenantMiddleware`, lewat header
 * `X-Tenant-ID`, yang mengecek — dan header itu tidak pernah dikirim
 * di jalur API key). Tanpa fungsi ini, tenant yang di-SUSPEND (mis.
 * nunggak tagihan — lihat komentar `enum TenantStatus` di
 * `schema.prisma`) API key partner-nya tetap bisa dipakai penuh.
 *
 * SENGAJA fail-CLOSED (beda dari `resolveTenantPlanSafe` yang
 * fail-soft di file sebelah) — TIDAK ada try/catch di sini, error
 * dibiarkan MENJALAR: ini keputusan kontrol akses (boleh/tidak boleh
 * masuk), bukan sekadar angka kuota yang tier default-nya cukup aman
 * dipakai sebagai fallback. Kegagalan lookup yang diam-diam
 * dianggap "aktif" akan membuka celah persis di skenario yang ingin
 * dicegah SUSPENDED (bypass pembekuan akses karena database/cache
 * sedang bermasalah). Praktiknya risiko ini kecil: `userRepository
 * .findById` yang dipanggil tepat setelah ini di `authMiddleware`
 * juga TIDAK fail-soft, jadi outage database yang genuinely
 * mempengaruhi kedua query itu sudah menggagalkan request lewat jalur
 * lain juga.
 */
export async function isTenantActiveForApiKey(tenantId: string | null): Promise<boolean> {
  if (!tenantId) {
    // API key tanpa tenant (masa transisi Phase 11, lihat komentar
    // `resolveTenantPlanSafe`) — tidak ada status untuk ditegakkan.
    return true;
  }
  return tenantService.isActiveById(tenantId);
}
