import type { RoleName } from '../types/role';

/**
 * Permission — SELALU berformat `"<resource>.<action>"`, daftar
 * TERTUTUP (union literal, bukan string bebas) supaya salah ketik
 * nama permission (mis. `event.craete`) ketahuan saat compile,
 * bukan diam-diam gagal saat runtime.
 *
 * Menambah permission baru: tambahkan literal-nya di sini DAN
 * masukkan ke role yang berhak di `ROLE_PERMISSIONS` di bawah.
 */
export type Permission =
  | 'event.read'
  | 'event.create'
  | 'event.update'
  | 'event.delete'
  // Kapabilitas "bertindak atas event MILIK ORANG LAIN" (moderasi) —
  // berbeda dari `event.update`/`event.delete` yang hanya menyatakan
  // "boleh mengubah/menghapus event" secara umum (termasuk milik
  // sendiri, mis. ORGANIZER). Tanpa permission terpisah ini, otorisasi
  // kepemilikan di `EventService` terpaksa hardcode `role === 'ADMIN'`
  // langsung — tepat kebalikan dari tujuan Phase 2 (menyatakan
  // KAPABILITAS, bukan identitas role).
  | 'event.moderate'
  | 'product.read'
  | 'product.create'
  | 'product.update'
  // Padanan `event.moderate` untuk Product — lihat komentar di atas.
  | 'product.moderate'
  | 'upload.create'
  // Kapabilitas "akses/hapus file upload MILIK ORANG LAIN" — pola
  // yang sama persis seperti `event.moderate`/`product.moderate`
  // (Phase 4 upgrade, upload flow: access & delete).
  | 'upload.moderate'
  | 'user.read'
  | 'user.manage'
  // Kapabilitas "lihat riwayat login/logout user LAIN" — dipakai
  // `requirePermission('audit.read')` di endpoint admin
  // `GET /auth/admin/users/:id/login-history` (Phase 9 upgrade).
  // Sengaja permission TERPISAH dari `user.manage` — mem-baca riwayat
  // login adalah kapabilitas observability yang berbeda sifatnya dari
  // mengubah/menghapus akun user, walau saat ini kebetulan sama-sama
  // hanya dimiliki ADMIN.
  | 'audit.read'
  // Phase 16 upgrade (Enterprise Feature) — statistik agregat lintas
  // modul (`GET /dashboard/*`). Permission TERPISAH dari `audit.read`
  // meski keduanya kebetulan hanya dimiliki ADMIN sekarang — audit
  // log mentah (siapa melakukan apa) dan statistik agregat (berapa
  // banyak) adalah dua kapabilitas observability berbeda yang bisa
  // saja diberikan ke role berbeda di masa depan (mis. ORGANIZER
  // boleh lihat statistik tapi tidak audit log mentah).
  | 'dashboard.read'
  // Toggle feature flag — SENGAJA `.manage` (bukan `.read`/`.write`
  // terpisah) karena tidak ada kebutuhan "boleh lihat status flag
  // tapi tidak boleh mengubah" saat ini; hanya ADMIN yang berinteraksi
  // dengan flag sama sekali.
  | 'feature-flag.manage'
  // Phase 11 (Enterprise Architecture) — mengelola daftar tenant itu
  // sendiri (membuat/melihat/menonaktifkan tenant). SENGAJA terpisah
  // dari kapabilitas apa pun yang beroperasi DI DALAM satu tenant
  // (event/product/dst) — ini operasi lintas-tenant tingkat platform,
  // sama sekali bukan sesuatu yang boleh diberikan ke ORGANIZER
  // sekalipun mereka ADMIN di tenant-nya sendiri.
  | 'tenant.manage'
  // Fase 2 (Enterprise SSO) — mengelola konfigurasi SSO (issuer,
  // client secret) SATU TENANT. SENGAJA permission TERPISAH dari
  // `tenant.manage` meski saat ini kebetulan sama-sama hanya dipegang
  // ADMIN platform — mengelola KEBERADAAN tenant dan mengelola
  // KREDENSIAL SSO-nya adalah dua kapabilitas berbeda sifatnya
  // (yang kedua jauh lebih sensitif: client secret IdP pihak
  // ketiga), pola yang sama dengan pemisahan `event.moderate` dari
  // `event.update` di atas.
  | 'sso.manage';

/**
 * Pemetaan Role → Permission — jenjang eksplisit yang diminta:
 * Role membuka satu set Permission, Permission memutuskan boleh-
 * tidaknya satu Action. BUKAN sekadar `requireRole('ADMIN')` yang
 * mengikat otorisasi langsung ke nama role (yang berarti "siapa boleh
 * apa" tersebar implisit di seluruh route file) — di sini "siapa
 * boleh apa" terpusat di SATU tempat, dan route hanya menyatakan
 * PERMISSION yang dibutuhkan (`requirePermission('event.delete')`),
 * tidak peduli role mana pun yang kelak memilikinya.
 *
 * Statis di kode (bukan tabel database) — SADAR, bukan keterbatasan:
 * himpunan role di aplikasi ini tertutup (`ADMIN`/`ORGANIZER`/`USER`,
 * lihat `shared/types/role.ts`) dan jarang berubah; permission dinamis
 * per-baris-database baru benar-benar dibutuhkan kalau suatu saat ada
 * kebutuhan role KUSTOM yang dibuat sendiri oleh admin lewat UI —
 * belum menjadi kebutuhan aplikasi ini sekarang, dan membangunnya
 * lebih awal dari kebutuhan nyata hanya menambah kompleksitas migrasi
 * skema tanpa manfaat langsung.
 */
const ROLE_PERMISSIONS: Record<RoleName, readonly Permission[]> = {
  USER: ['event.read', 'product.read', 'upload.create'],
  ORGANIZER: [
    'event.read',
    'event.create',
    'event.update',
    'event.delete',
    'product.read',
    'product.create',
    'product.update',
    'upload.create',
  ],
  ADMIN: [
    'event.read',
    'event.create',
    'event.update',
    'event.delete',
    'event.moderate',
    'product.read',
    'product.create',
    'product.update',
    'product.moderate',
    'upload.create',
    'upload.moderate',
    'user.read',
    'user.manage',
    'audit.read',
    'dashboard.read',
    'feature-flag.manage',
    'tenant.manage',
    'sso.manage',
  ],
};

export function hasPermission(role: RoleName, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Dipakai murni untuk keperluan debug/dokumentasi (mis. endpoint `GET /auth/me` yang ingin menampilkan permission user ke klien) — bukan dipanggil di jalur otorisasi apa pun. */
export function getPermissionsForRole(role: RoleName): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}
