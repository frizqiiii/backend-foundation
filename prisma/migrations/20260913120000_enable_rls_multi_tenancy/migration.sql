-- Fase 4 (Master Roadmap Enterprise) — Row-Level Security untuk
-- Multi-Tenancy. Lihat docs/tenant-migration-strategy.md bagian
-- "Phase 2: RLS sebagai lapisan kedua" untuk desain lengkap & alasan
-- setiap keputusan di bawah.
--
-- KENAPA INI ADA: sampai migration ini, isolasi tenant 100%
-- bergantung pada Repository yang MENAMBAHKAN `where.tenantId` secara
-- manual (lihat `product.repository.ts`, `event.repository.ts`, dst).
-- Satu endpoint baru yang lupa menambahkan filter itu = kebocoran data
-- lintas tenant, tanpa jaring pengaman kedua. Migration ini
-- memindahkan penegakan aturan itu ke level database: bahkan kalau
-- KODE APLIKASI bug/lupa filter, Postgres sendiri yang menolak.
--
-- SCOPE ITERASI PERTAMA — 5 tabel yang datanya murni domain bisnis
-- tenant-scoped: products, events, api_keys, webhook_endpoints,
-- export_jobs. Tabel `users` SENGAJA BELUM masuk di iterasi ini —
-- tabel itu punya alur akses ganda (login by email tanpa tenant
-- context, registrasi membuat baris dengan tenant_id NULL) yang butuh
-- desain policy terpisah (INSERT policy longgar untuk registrasi +
-- SELECT policy khusus alur login). Dicatat sebagai item lanjutan di
-- docs/tenant-migration-strategy.md, BUKAN celah yang terlewat.
--
-- MEKANISME: setiap policy membaca DUA session variable yang di-set
-- oleh aplikasi lewat `set_config(..., true)` (setara `SET LOCAL`,
-- lihat `tenant.middleware.ts`):
--   - app.tenant_id   -> UUID tenant yang sedang aktif untuk transaksi
--                        ini. TIDAK di-set sama sekali = current_setting
--                        mengembalikan NULL.
--   - app.bypass_rls  -> 'on' untuk operasi internal yang SENGAJA
--                        lintas-tenant (mis. job admin/migrasi data).
--                        Dipakai TERBATAS & wajib melalui code path
--                        yang eksplisit (lihat `withRlsBypass` di
--                        `tenant-context.ts`), bukan dipanggil bebas.
--
-- FAIL-CLOSED BY DESAIN: `tenant_id = current_setting('app.tenant_id', true)`
-- otomatis bernilai FALSE (bukan error, bukan "true karena kosong")
-- kalau salah satu sisi NULL — termasuk kalau app.tenant_id belum
-- pernah di-set SAMA SEKALI. Artinya: TIDAK ADA fallback "kalau lupa
-- set tenant context, tampilkan semua data" — defaultnya justru
-- "tidak tampilkan apa-apa", persis kebalikan dari cara aplikasi ini
-- berperilaku SEBELUM RLS (mode transisi tanpa header = terlihat
-- semua). Ini keputusan sadar (lihat diskusi Fase 4): jauh lebih aman
-- gagal dengan "data kosong" daripada gagal dengan "data bocor".
--
-- CAVEAT YANG PERLU DIKETAHUI (didokumentasikan, bukan disembunyikan):
-- baris LAMA yang tenant_id-nya NULL (data sebelum Phase 11 yang belum
-- sempat di-backfill) akan IKUT TIDAK TERLIHAT begitu ada tenant
-- context aktif (NULL = 'xxx' tetap NULL/false, bukan match apa pun).
-- Baris semacam ini hanya bisa diakses lewat app.bypass_rls sampai
-- benar-benar dibackfill ke tenant tertentu.

DO $$
DECLARE
  affected_table text;
BEGIN
  FOREACH affected_table IN ARRAY ARRAY['products', 'events', 'api_keys', 'webhook_endpoints', 'export_jobs']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', affected_table);

    -- FORCE ROW LEVEL SECURITY — TANPA baris ini, Postgres membiarkan
    -- role PEMILIK tabel (biasanya role yang sama dipakai Prisma untuk
    -- connect DAN menjalankan migration) otomatis BYPASS seluruh
    -- policy. Ini gotcha paling umum & paling berbahaya soal RLS:
    -- tanpa FORCE, RLS "aktif" di `\d+ tabel` tapi TIDAK PERNAH benar-
    -- benar menegakkan apa pun untuk koneksi aplikasi sungguhan.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', affected_table);

    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I ' ||
      'USING (' ||
      '  current_setting(''app.bypass_rls'', true) = ''on'' ' ||
      '  OR tenant_id = current_setting(''app.tenant_id'', true)' ||
      ') ' ||
      'WITH CHECK (' ||
      '  current_setting(''app.bypass_rls'', true) = ''on'' ' ||
      '  OR tenant_id = current_setting(''app.tenant_id'', true)' ||
      ')',
      affected_table
    );
  END LOOP;
END $$;
