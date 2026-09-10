import type { PrismaClient, Event, Prisma } from '@prisma/client';
import { pagination } from '../../shared/pagination';
import { getTenantContext } from '../../shared/tenant/tenant-context';
import type { ListEventsQueryDto } from './event.dto';

export interface CreateEventData {
  title: string;
  description?: string;
  category: string;
  location: string;
  date: Date;
  ownerId: string;
}

export type UpdateEventData = Partial<Omit<CreateEventData, 'ownerId'>>;

/**
 * Repository Layer untuk modul Events.
 */
export class EventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Phase 11 — `tenantId` diisi OTOMATIS dari tenant context aktif,
   * bukan field yang wajib dioper `CreateEventData` — sama pola &
   * alasan seperti `ProductRepository.create`: request tanpa header
   * tenant tetap membuat event seperti sebelum Phase 11.
   */
  async create(data: CreateEventData): Promise<Event> {
    const { tenantId } = getTenantContext();
    return this.prisma.event.create({ data: { ...data, tenantId } });
  }

  /**
   * Filter (kategori, lokasi, rentang tanggal) dan search (judul)
   * dibangun sebagai satu klausa `where` gabungan, dieksekusi
   * langsung di level query Prisma/PostgreSQL — bukan mengambil semua
   * baris lalu memfilter di memori Node.js.
   *
   * `findMany` + `count` dibungkus `$transaction` agar keduanya
   * membaca snapshot data yang sama persis; tanpa ini, ada celah
   * kecil di mana `total` (dipakai untuk `totalPages`) bisa tidak
   * sinkron dengan `data` jika ada insert/delete event lain di antara
   * dua query terpisah.
   */
  async findMany(query: ListEventsQueryDto): Promise<{ data: Event[]; total: number }> {
    const where = this.buildWhereClause(query);

    const [data, total] = await this.prisma.$transaction([
      this.prisma.event.findMany({
        where,
        ...pagination(query.page, query.limit),
        orderBy: { date: 'asc' },
      }),
      this.prisma.event.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * `findFirst`, BUKAN `findUnique` — `findUnique` Prisma hanya
   * menerima kolom unique di `where` (di sini `id`), TIDAK bisa
   * dikombinasikan dengan kondisi tambahan (`deletedAt: null`) dalam
   * satu query. `findFirst` menerima `where` bebas sekaligus tetap
   * memakai index `id` yang sama (primary key), jadi tidak ada
   * trade-off performa dari perubahan ini.
   */
  /**
   * `findFirst`, BUKAN `findUnique` — `findUnique` Prisma hanya
   * menerima kolom unique di `where` (di sini `id`), TIDAK bisa
   * dikombinasikan dengan kondisi tambahan (`deletedAt: null`) dalam
   * satu query. `findFirst` menerima `where` bebas sekaligus tetap
   * memakai index `id` yang sama (primary key), jadi tidak ada
   * trade-off performa dari perubahan ini.
   *
   * Tenant-scoped SECARA OPSIONAL (P1 hardening) — pola & alasan
   * IDENTIK dengan `buildWhereClause` (findMany) di atas: `where.tenantId`
   * hanya ditambahkan kalau tenant context sedang aktif, supaya
   * client lama (tanpa header `X-Tenant-ID`) tetap berperilaku
   * persis seperti sebelum Phase 11. SEBELUM perbaikan ini,
   * `findById` adalah SATU-SATUNYA method baca di repository ini
   * yang TIDAK ikut tenant-scoped seperti `findMany` — padahal
   * dipakai langsung oleh `getEventById`/`updateEvent`/`deleteEvent`
   * di Service TANPA verifikasi tenant tambahan apa pun di sana,
   * beda dari `ProductRepository.findById` (yang sudah lebih dulu
   * diperbaiki dan masih punya lapisan `isOwner` di Service sebagai
   * pertahanan kedua). Artinya sebelum ini, user tenant B yang tahu/
   * menebak UUID event milik tenant A bisa membaca, mengubah, atau
   * menghapusnya lewat `GET`/`PUT`/`DELETE /events/:id` — celah
   * isolasi tenant nyata, bukan sekadar defense-in-depth seperti di
   * Product.
   */
  async findById(id: string): Promise<Event | null> {
    const { tenantId } = getTenantContext();
    const where: Prisma.EventWhereInput = { id, deletedAt: null };
    if (tenantId) {
      where.tenantId = tenantId;
    }
    return this.prisma.event.findFirst({ where });
  }

  async update(id: string, data: UpdateEventData): Promise<Event> {
    return this.prisma.event.update({ where: { id }, data });
  }

  /**
   * Soft delete (Phase 8) — mengisi `deletedAt`, BUKAN
   * `prisma.event.delete()` yang menghapus baris secara fisik. Lihat
   * komentar lengkap pada kolom `deletedAt` di `schema.prisma` untuk
   * alasannya (menjaga integritas rujukan dari AuditLog & data lain).
   */
  async delete(id: string): Promise<Event> {
    return this.prisma.event.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private buildWhereClause(query: ListEventsQueryDto): Prisma.EventWhereInput {
    // `deletedAt: null` WAJIB ada di SETIAP query baca — event yang
    // sudah soft-deleted tidak boleh pernah muncul di listing publik,
    // sama seperti kalau baris itu benar-benar sudah tidak ada.
    const where: Prisma.EventWhereInput = { deletedAt: null };

    // Phase 11 — sama pola & alasan seperti
    // `ProductRepository.findMany`: filter tenant HANYA ditambahkan
    // kalau tenant context aktif, supaya request tanpa header tenant
    // tetap melihat semua event lintas tenant seperti sebelum
    // Phase 11 (backward compatible).
    const { tenantId } = getTenantContext();
    if (tenantId) {
      where.tenantId = tenantId;
    }

    if (query.search) {
      where.title = { contains: query.search, mode: 'insensitive' };
    }
    if (query.category) {
      where.category = query.category;
    }
    if (query.location) {
      where.location = { contains: query.location, mode: 'insensitive' };
    }
    if (query.dateFrom || query.dateTo) {
      where.date = {
        ...(query.dateFrom ? { gte: query.dateFrom } : {}),
        ...(query.dateTo ? { lte: query.dateTo } : {}),
      };
    }

    return where;
  }
}
