import type { Request, Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { TenantService } from '../../modules/tenants/tenant.service';
import { runWithTenantContext } from './tenant-context';
import { TENANT_HEADER_NAME } from './tenant.constants';

// Instance module-level, sama pola dengan `*.routes.ts` lain (satu
// instance dibagi seluruh request, bukan dibuat ulang per-request) —
// tidak diimpor dari `modules/tenants/tenant.routes.ts` supaya arah
// dependency tetap konsisten dengan seluruh codebase ini
// (`modules/*` boleh bergantung ke `shared/*`, TIDAK sebaliknya).
const tenantRepository = new TenantRepository(prisma);
const tenantService = new TenantService(tenantRepository);

/**
 * Tenant Middleware (Phase 11, diperluas Fase 4 — RLS) — dipasang
 * GLOBAL di `app.ts`, SEBELUM router bisnis mana pun, supaya tenant
 * context sudah aktif untuk SELURUH request sebelum menyentuh
 * Controller/Service apa pun.
 *
 * MODE TRANSISI — SENGAJA "backward compatible", BUKAN wajib:
 *   - Ada header `X-Tenant-ID` & slug-nya valid+aktif -> tenant context
 *     terisi, request lanjut seperti biasa, DIBUNGKUS dalam satu
 *     transaksi RLS (lihat blok Fase 4 di bawah).
 *   - Ada header tapi slug tidak valid/tenant SUSPENDED -> request
 *     ditolak (403) SEDINI mungkin, sebelum masuk ke logika bisnis
 *     apa pun.
 *   - TIDAK ADA header sama sekali -> tenant context dibiarkan kosong
 *     (`tenantId: null`, `db: null`) dan request tetap lanjut TANPA
 *     transaksi tambahan apa pun. Endpoint yang menyentuh tabel
 *     ber-RLS akan fail-closed secara alami di level database (lihat
 *     migration `20260913120000_enable_rls_multi_tenancy`) kalau
 *     memang seharusnya tenant-scoped.
 *
 * FASE 4 (RLS) — KENAPA DIBUNGKUS `$transaction`, BUKAN sekadar
 * `SET LOCAL` biasa: `set_config(name, value, true)` (setara
 * `SET LOCAL`) HANYA berlaku sampai akhir TRANSAKSI yang sama —
 * dipanggil sebagai statement berdiri sendiri (di luar transaksi
 * eksplisit), nilainya sudah hilang SEBELUM query berikutnya sempat
 * jalan (setiap statement standalone di Postgres = transaksi implisit
 * sendiri, auto-commit begitu statement itu selesai). Supaya
 * `app.tenant_id` benar-benar "menempel" ke seluruh query request ini,
 * satu-satunya cara adalah membungkus SISA SIKLUS request (mulai dari
 * titik ini sampai response selesai dikirim) dalam SATU transaksi
 * interaktif Prisma, dan menyimpan transaction client itu (`tx`) di
 * tenant context supaya Repository bisa memakainya lewat
 * `getScopedPrisma()`.
 *
 * TRADE-OFF YANG DITERIMA (sesuai prinsip roadmap — didokumentasikan,
 * bukan disembunyikan): SETIAP request yang punya tenant aktif
 * menahan SATU koneksi/transaksi database selama siklus hidup request
 * itu, TERMASUK selama I/O non-database di dalamnya (mis. upload ke
 * S3, pengiriman email) — beda dari sebelumnya, di mana tiap query
 * Prisma jalan sebagai statement pendek yang segera melepas
 * koneksinya. Untuk request yang lama (mis. upload file besar), ini
 * bisa menaikkan tekanan ke connection pool. Mitigasi iterasi
 * pertama: `timeout` digenerouskan jauh di atas default Prisma
 * (30 detik, bukan 5 detik) supaya request wajar tidak keburu gagal.
 * Kalau ini terbukti jadi bottleneck nyata di beban produksi, opsi
 * lanjutan (BELUM dikerjakan, dicatat sebagai follow-up) adalah
 * memindahkan `set_config` ke transaksi MIKRO per-panggilan Repository
 * (lewat Prisma Client Extension) alih-alih satu transaksi per
 * seluruh request — lebih rumit untuk dikerjakan benar (perlu
 * menangani kasus Repository yang sudah membuka `$transaction`
 * eksplisit sendiri), makanya TIDAK dipilih untuk iterasi pertama ini.
 */
export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const rawHeader = req.headers[TENANT_HEADER_NAME];
    const slug = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    if (!slug) {
      runWithTenantContext({ tenantId: null, tenantSlug: null, db: null }, () => next());
      return;
    }

    // Melempar ForbiddenError kalau slug tidak dikenal/tenant tidak
    // aktif — ditangkap oleh `next(error)` di catch block bawah,
    // diteruskan ke `errorHandler` global seperti error lainnya. Ini
    // terjadi SEBELUM transaksi RLS dibuka, jadi tidak ada transaksi
    // menggantung untuk request yang ditolak di sini.
    const tenant = await tenantService.resolveActiveTenantBySlug(slug);

    await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        // `set_config` lewat tagged template ($executeRaw) — nilainya
        // di-parameterkan otomatis oleh Prisma (bukan string
        // interpolation manual), jadi aman dari SQL injection walau
        // `tenant.id` berasal dari input eksternal (header request).
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

        await runWithTenantContext(
          { tenantId: tenant.id, tenantSlug: tenant.slug, tenantPlan: tenant.plan, db: tx },
          async () => {
            next();
            // Menahan transaksi tetap terbuka sampai response BENAR-
            // BENAR selesai dikirim — `next()` di atas memulai sisa
            // middleware chain/Controller secara async, tapi tidak
            // bisa di-`await` langsung (bukan Promise). Menunggu event
            // `finish`/`close` di response adalah cara Express yang
            // sudah lazim untuk tahu "request ini benar-benar selesai
            // diproses", termasuk untuk request yang berakhir di
            // errorHandler global (tetap memanggil res.json/res.end).
            await new Promise<void>((resolve, reject) => {
              res.once('finish', resolve);
              res.once('close', resolve);
              res.once('error', reject);
            });
          }
        );
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      }
    );
  } catch (error) {
    next(error);
  }
}
