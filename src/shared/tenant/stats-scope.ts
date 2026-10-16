import { getTenantContext } from './tenant-context';
import { ForbiddenError } from '../utils/http-error';

/**
 * R21 — cakupan statistik (dashboard, reporting, analytics).
 *
 * Dua mode, ditentukan oleh konteks tenant aktif (header `X-Tenant-ID`; ikatan header ke identitas dijamin S1):
 *  - TENANT (header ada): users/events/products dihitung hanya untuk tenant itu.
 *  - PLATFORM (tanpa header): hanya ADMIN platform (user tanpa tenant, lihat `requireTenantOrPlatformAdmin`); angka
 *    users/events/products global lintas tenant.
 *
 * `audit_logs` dan `file_uploads` TIDAK punya kolom `tenant_id`, sehingga metrik turunannya (ringkasan audit, DAU,
 * jumlah upload) tidak bisa dipisah per tenant. Metrik itu hanya tersedia di mode PLATFORM; di mode TENANT ia ditolak
 * (403) supaya admin tenant tidak membaca agregat lintas tenant. Memisahkannya per tenant butuh migrasi skema
 * (tambah `tenant_id` di kedua tabel) dan sengaja BUKAN bagian R21.
 */
export function assertPlatformScope(): void {
  if (getTenantContext().tenantId != null) {
    throw new ForbiddenError(
      'Metrik ini hanya tersedia untuk admin platform (tanpa header X-Tenant-ID)'
    );
  }
}
