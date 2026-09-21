import type { PrismaClient, Prisma, User } from '@prisma/client';
import { getTenantContext } from '../../shared/tenant/tenant-context';

/**
 * Klien Prisma yang berlaku di dalam SATU transaksi — lihat komentar
 * yang sama di `auth.repository.ts` untuk konteks lengkapnya
 * (Phase 8, dipakai oleh `AuthService.resetPassword`).
 */
type TransactionClient = Prisma.TransactionClient;

/**
 * Repository Layer — HANYA bertanggung jawab atas akses data (query
 * Prisma). Tidak ada business logic (hashing, validasi, dsb) di sini,
 * sehingga jika suatu saat ORM/database diganti, hanya file ini yang
 * perlu disentuh.
 */
export class UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * `findFirst`, BUKAN `findUnique` — sama alasannya seperti
   * `EventRepository.findById`: `findUnique` tidak bisa dikombinasikan
   * dengan kondisi tambahan (`deletedAt: null`) dalam satu query.
   * `email` tetap unique di skema, jadi tidak ada trade-off performa.
   *
   * WAJIB filter `deletedAt: null` — akun yang sudah di-soft-delete
   * TIDAK boleh bisa login lagi. Tanpa filter ini, `AuthService.login`
   * akan tetap menemukan user yang sudah "dihapus" dan mengizinkannya
   * masuk seolah akunnya masih aktif.
   *
   * Phase 11 — SENGAJA TIDAK difilter oleh tenant context, berbeda
   * dari `ProductRepository`/`EventRepository`. `email` didesain unik
   * SECARA GLOBAL (lihat catatan di `schema.prisma`), dan alur login
   * (`AuthService.login`) memanggil method ini SEBELUM ada cara untuk
   * tahu tenant mana yang "seharusnya" — user login duluan, baru
   * setelah itu tenant context relevan untuk request-request
   * berikutnya. Menambah filter tenant di sini akan mengunci user
   * keluar dari akunnya sendiri hanya karena client kebetulan tidak
   * mengirim header `X-Tenant-ID` saat login.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email, deletedAt: null } });
  }

  /**
   * Sama seperti `findByEmail` — filter `deletedAt: null` memastikan
   * refresh token milik user yang sudah dihapus juga ikut ditolak
   * (`AuthService.refresh` mem-lookup user lewat method ini; user
   * yang tidak ditemukan diperlakukan sebagai token tidak valid, lihat
   * komentar "User sudah terhapus" di `auth.service.ts`).
   *
   * Phase 11 — tenant-unaware dengan alasan yang sama seperti
   * `findByEmail` di atas: dipakai di jalur auth (mis. memvalidasi
   * JWT yang sudah diterbitkan), bukan jalur listing tenant-scoped.
   */
  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Temuan T15 — TANPA filter `deletedAt`, KHUSUS untuk erasure/retensi data (`PrivacyService.eraseForUser`).
   *
   * `findById` di atas SENGAJA menyembunyikan akun soft-deleted (jalur auth harus memperlakukan
   * akun terhapus sebagai tidak ada). Tetapi job retensi (`enforce-data-retention`) justru menargetkan
   * PERSIS akun-akun soft-deleted (`findSoftDeletedPastRetentionPeriod`); kalau `eraseForUser`
   * mencari lewat `findById`, setiap kandidat dianggap "tidak ditemukan" dan job gagal tiap malam
   * tanpa pernah meng-erasure satu akun pun. JANGAN dipakai di jalur autentikasi/otorisasi.
   */
  async findByIdIncludingDeleted(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /**
   * Dipaginasi (Phase 3 — sebelumnya mengambil SELURUH baris user
   * tanpa batas sama sekali, pola yang sama seperti masalah lama di
   * `ProductRepository.findAll` sebelum Phase 8). `findMany` + `count`
   * dibungkus `$transaction` agar `total` tetap sinkron dengan `data`
   * dari snapshot yang sama, konsisten dengan pola di Event/Product.
   *
   * Phase 11 — BERBEDA dari `findByEmail`/`findById` di atas, method
   * ini dipakai untuk LISTING admin (bukan jalur auth), jadi pola
   * opt-in tenant filter yang sama seperti
   * `ProductRepository.findMany` berlaku di sini.
   */
  async findMany(params: { skip: number; take: number }): Promise<{ data: User[]; total: number }> {
    const where: Prisma.UserWhereInput = { deletedAt: null };
    const { tenantId } = getTenantContext();
    if (tenantId) {
      where.tenantId = tenantId;
    }

    const [data, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip: params.skip,
        take: params.take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * Phase 11 — `tenantId` diisi OTOMATIS dari tenant context aktif
   * saat registrasi, sama pola seperti `ProductRepository.create`.
   */
  async create(data: {
    email: string;
    password?: string | null;
    name: string;
    emailVerifiedAt?: Date;
  }): Promise<User> {
    const { tenantId } = getTenantContext();
    return this.prisma.user.create({ data: { ...data, tenantId } });
  }

  /**
   * `tx` opsional (Phase 8) — kalau diberikan (mis. dari
   * `AuthService.resetPassword` lewat `AuthRepository.runInTransaction`),
   * update ini ikut serta di transaksi TERSEBUT alih-alih membuka
   * koneksi/statement terpisah lewat `this.prisma` milik repository
   * ini sendiri.
   */
  async update(
    id: string,
    data: Partial<{ password: string; emailVerifiedAt: Date }>,
    tx?: TransactionClient
  ): Promise<User> {
    return (tx ?? this.prisma).user.update({ where: { id }, data });
  }

  /**
   * Soft delete (Phase 3) — mengisi `deletedAt`, BUKAN
   * `prisma.user.delete()` yang menghapus baris secara fisik dan akan
   * ikut men-cascade-delete seluruh Product/Event/RefreshToken milik
   * user ini (lihat `onDelete: Cascade` di relasi masing-masing model)
   * — konsekuensi yang HAMPIR PASTI tidak diinginkan hanya karena
   * admin menonaktifkan satu akun.
   */
  async delete(id: string): Promise<User> {
    return this.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /**
   * Fase 2 (Data retention policy) — akun yang sudah SOFT-DELETE
   * (`deletedAt` terisi) LEBIH LAMA dari `cutoff`, DAN belum pernah
   * di-erasure (`erasedAt` masih kosong) — daftar inilah yang
   * diproses `enforce-data-retention.job.ts` untuk otomatis di-scrub
   * PII-nya begitu masa tenggang habis. Tanpa `erasedAt IS NULL`,
   * job ini akan mencoba meng-erasure ulang akun yang sudah pernah
   * diproses (aman secara logika — `PrivacyService.eraseForUser`
   * menolak akun yang sudah `erasedAt` — tapi query ini menghindari
   * pekerjaan sia-sia berulang setiap hari untuk akun yang sama).
   */
  async findSoftDeletedPastRetentionPeriod(cutoff: Date): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { deletedAt: { lt: cutoff }, erasedAt: null },
    });
  }
}
