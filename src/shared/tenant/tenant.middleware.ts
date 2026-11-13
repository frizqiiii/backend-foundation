import type { Request, Response, NextFunction } from 'express';
import type { Prisma, Tenant } from '@prisma/client';
import { prisma } from '../config/database';
import { TenantRepository } from '../../modules/tenants/tenant.repository';
import { TenantService } from '../../modules/tenants/tenant.service';
import { ApiKeyRepository } from '../../modules/api-keys/api-key.repository';
import { ApiKeyService } from '../../modules/api-keys/api-key.service';
import { API_KEY_PREFIX } from '../security/api-key-auth';
import { runWithTenantContext } from './tenant-context';
import { TENANT_HEADER_NAME } from './tenant.constants';

// Instance module-level, sama pola dengan `*.routes.ts` lain (satu
// instance dibagi seluruh request, bukan dibuat ulang per-request) —
// tidak diimpor dari `modules/tenants/tenant.routes.ts` supaya arah
// dependency tetap konsisten dengan seluruh codebase ini
// (`modules/*` boleh bergantung ke `shared/*`, TIDAK sebaliknya).
const tenantRepository = new TenantRepository(prisma);
const tenantService = new TenantService(tenantRepository);
// R23 — hanya untuk MEMILIH tenant dari API key (lihat `resolveTenant`); autentikasi sesungguhnya tetap di `authMiddleware`.
const apiKeyService = new ApiKeyService(new ApiKeyRepository(prisma));

/** Token API key dari header `Authorization: Bearer bfk_...`, atau `null` kalau header bukan API key. */
function extractApiKey(authorization: string | undefined): string | null {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return null;
  }
  const token = authorization.slice('Bearer '.length).trim();
  return token.startsWith(API_KEY_PREFIX) ? token : null;
}

/**
 * Menentukan tenant request. Header `X-Tenant-ID` selalu menang. Tanpa header, request ber-API key yang valid memakai
 * tenant milik key-nya (R23); selain itu `null` (tanpa konteks tenant, perilaku lama). `authMiddleware` kemudian tetap
 * memvalidasi key penuh dan menegakkan pengikatan S1, jadi hasil di sini hanya memilih konteks, bukan memberi akses.
 */
async function resolveTenant(req: Request, slug: string | undefined): Promise<Tenant | null> {
  if (slug) {
    return tenantService.resolveActiveTenantBySlug(slug);
  }
  const rawKey = extractApiKey(req.headers.authorization);
  if (!rawKey) {
    return null;
  }
  const keyTenantId = await apiKeyService.findTenantIdByRawKey(rawKey);
  return keyTenantId ? tenantService.resolveActiveTenantById(keyTenantId) : null;
}

type ResponseEnd = (...args: unknown[]) => Response;

/** Kendali atas respons yang ditahan sampai transaksi request ter-COMMIT (lihat `holdResponseUntilCommit`). */
interface ResponseHold {
  /** Resolve begitu handler memanggil `res.end` (respons siap) atau koneksi tertutup; reject kalau `res` error. */
  ready: Promise<void>;
  /** Mengirim respons yang ditahan. Dipanggil SETELAH commit berhasil. */
  release: () => void;
  /** Membuang respons yang ditahan dan mengembalikan `res.end` asli. Dipanggil kalau commit GAGAL. */
  discard: () => void;
}

/**
 * Menahan BYTE respons sampai transaksi request ter-COMMIT.
 *
 * KENAPA: Express mengirim respons begitu handler memanggil `res.json`/`res.send` (-> `res.end`), padahal transaksi
 * request (lihat `tenantMiddleware`) baru di-COMMIT sesudahnya. Klien yang menerima `201` dan langsung memakai hasilnya
 * lewat koneksi database lain (mis. API key yang baru dibuat dipakai di request berikutnya) bisa mendahului COMMIT —
 * barisnya belum terlihat, hasilnya `401`/data kosong. Terbukti dengan eksperimen: `commit_delay` Postgres diperlambat
 * 50 ms -> 20 dari 30 pemakaian pertama key mendapat 401 (semuanya valid setelah 41-148 ms); tanpa perlambatan 0 dari 100.
 *
 * CARA: `res.end` dibungkus. Panggilan pertama hanya menyimpan argumennya dan menandai respons siap (status, header,
 * dan body sudah diisi Express; belum ada byte yang keluar). `tenantMiddleware` lalu COMMIT dan baru memanggil `end`
 * yang asli lewat `release()`. Kalau COMMIT gagal, `discard()` membuang respons itu supaya klien menerima error, bukan
 * sukses palsu.
 *
 * TIDAK ditahan (perilaku lama): respons yang headernya sudah terkirim (`res.headersSent`, mis. streaming lewat
 * `res.write`/`pipe`), karena byte-nya sudah keluar dan tidak bisa ditarik; serta panggilan `end` kedua.
 */
function holdResponseUntilCommit(res: Response): ResponseHold {
  const originalEnd = res.end as unknown as ResponseEnd;
  let heldArgs: unknown[] | null = null;
  let markReady: () => void = () => undefined;

  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    res.once('close', resolve);
    res.once('error', reject);
  });

  res.end = function holdingEnd(this: Response, ...args: unknown[]): Response {
    if (res.headersSent || heldArgs !== null) {
      const result = originalEnd.apply(this, args);
      markReady();
      return result;
    }
    heldArgs = args;
    markReady();
    return this;
  } as Response['end'];

  return {
    ready,
    release: () => {
      res.end = originalEnd as unknown as Response['end'];
      const args = heldArgs;
      heldArgs = null;
      // Koneksi yang sudah putus tidak perlu dibalas.
      if (args !== null && !res.destroyed && !res.writableEnded) {
        originalEnd.apply(res, args);
      }
    },
    discard: () => {
      res.end = originalEnd as unknown as Response['end'];
      heldArgs = null;
    },
  };
}

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
 * titik ini sampai handler selesai membuat respons) dalam SATU
 * transaksi interaktif Prisma, dan menyimpan transaction client itu
 * (`tx`) di tenant context supaya Repository bisa memakainya lewat
 * `getScopedPrisma()`.
 *
 * COMMIT SEBELUM RESPONS TERKIRIM: byte respons ditahan sampai
 * transaksi ter-COMMIT (lihat `holdResponseUntilCommit`), sehingga
 * klien yang menerima sukses selalu bisa langsung membaca hasil
 * tulisannya lewat koneksi lain. Yang BELUM tercakup: pekerjaan di
 * luar request ini yang berjalan SEBELUM commit (mis. job BullMQ yang
 * di-enqueue di tengah request) — untuk itu tetap pakai
 * `runInTenantTransaction` (R19).
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
 * Menahan respons sampai commit menambah satu round-trip COMMIT
 * (milidetik) ke latensi yang dilihat klien untuk setiap request
 * bertenant, termasuk yang hanya membaca.
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
  const held: { current: ResponseHold | null } = { current: null };
  try {
    const rawHeader = req.headers[TENANT_HEADER_NAME];
    const slug = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    // Melempar ForbiddenError kalau slug tidak dikenal/tenant tidak
    // aktif — ditangkap oleh `next(error)` di catch block bawah,
    // diteruskan ke `errorHandler` global seperti error lainnya. Ini
    // terjadi SEBELUM transaksi RLS dibuka, jadi tidak ada transaksi
    // menggantung untuk request yang ditolak di sini.
    const tenant = await resolveTenant(req, slug);

    if (!tenant) {
      runWithTenantContext({ tenantId: null, tenantSlug: null, db: null }, () => next());
      return;
    }

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
            const hold = holdResponseUntilCommit(res);
            held.current = hold;
            next();
            // Menahan transaksi tetap terbuka sampai handler SELESAI
            // membuat respons — `next()` di atas memulai sisa
            // middleware chain/Controller secara async, tapi tidak
            // bisa di-`await` langsung (bukan Promise). Handler
            // menandai selesai dengan memanggil `res.end` (lewat
            // `res.json`/`res.send`), termasuk untuk request yang
            // berakhir di errorHandler global. Byte-nya BELUM keluar
            // saat ini: baru dikirim `release()` di bawah, setelah
            // transaksi ter-COMMIT. Koneksi yang putus lebih dulu
            // (`close`) juga melepas penantian ini.
            await hold.ready;
          }
        );
      },
      {
        maxWait: 10_000,
        timeout: 30_000,
      }
    );

    // Transaksi sudah ter-COMMIT di titik ini: aman mengirim respons.
    held.current?.release();
  } catch (error) {
    // Commit/transaksi gagal: buang respons yang mungkin sudah disiapkan supaya klien menerima error, bukan sukses palsu.
    held.current?.discard();
    next(error);
  }
}
