import type { PrismaClient, FileUpload } from '@prisma/client';

/**
 * Repository Layer — HANYA akses data (query Prisma), pola yang sama
 * seperti repository modul lain. Dipakai untuk mencatat kepemilikan
 * file (Phase 4 upgrade) — sebelumnya modul `upload` tidak menyimpan
 * jejak apa pun ke database, file langsung ke S3 tanpa tahu siapa
 * pemiliknya.
 */
export class UploadRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    key: string;
    url: string;
    originalName: string;
    mimetype: string;
    sizeBytes: number;
    userId: string;
  }): Promise<FileUpload> {
    return this.prisma.fileUpload.create({ data });
  }

  async findById(id: string): Promise<FileUpload | null> {
    return this.prisma.fileUpload.findUnique({ where: { id } });
  }

  /**
   * Fase 2 (Data retention/GDPR erasure) — daftar SEMUA file milik
   * satu user, dipakai `PrivacyService.eraseUserData` untuk menghapus
   * objek storage-nya SATU PER SATU sebelum baris metadata-nya ikut
   * dihapus (lihat alasan urutan hapus storage-dulu di
   * `UploadService.deleteFile`, prinsip yang sama dipakai di sini).
   */
  async findByUser(userId: string): Promise<FileUpload[]> {
    return this.prisma.fileUpload.findMany({ where: { userId } });
  }

  /**
   * Hapus baris metadata secara FISIK — BEDA dari pola soft delete di
   * `User`/`Product`/`Event`. Alasannya: begitu objek S3-nya benar-benar
   * dihapus (`DeleteObjectCommand` di `UploadService.deleteFile`),
   * baris ini tidak lagi merujuk ke sesuatu yang bisa diakses — tidak
   * ada nilai bisnis dipertahankan (beda dari Product/Event yang tetap
   * relevan untuk riwayat/audit meski "dihapus" dari sisi pengguna).
   */
  async delete(id: string): Promise<FileUpload> {
    return this.prisma.fileUpload.delete({ where: { id } });
  }
}
