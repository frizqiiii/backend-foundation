import { randomUUID } from 'crypto';
import path from 'path';
import { objectStorageProvider } from '../../shared/integrations/storage';
import type { UploadRepository } from './upload.repository';
import type { RoleName } from '../../shared/types/role';
import { ForbiddenError, NotFoundError, BadRequestError } from '../../shared/utils/http-error';
import { hasPermission } from '../../shared/security/permissions';
import { matchesFileSignature } from '../../shared/security/file-signature';

export interface UploadedFileDto {
  id: string;
  url: string;
  key: string;
}

export interface FileMetadataDto {
  id: string;
  url: string;
  originalName: string;
  mimetype: string;
  sizeBytes: number;
  userId: string;
  createdAt: Date;
}

export interface RequesterContext {
  id: string;
  role: RoleName;
}

/**
 * Service Layer modul `upload`.
 *
 * SENGAJA tidak menyimpan file ke disk lokal server sama sekali —
 * `req.file.buffer` (hasil `multer.memoryStorage()`) langsung
 * di-upload lewat `objectStorageProvider` (Phase 15 — Enterprise
 * Integration, lihat `shared/integrations/storage/`). Tidak ada file
 * sementara yang perlu dibersihkan, dan implementasi ini tetap
 * bekerja di lingkungan container/serverless dengan filesystem
 * read-only atau ephemeral (mis. banyak platform PaaS/serverless).
 *
 * Phase 15 — `UploadService` TIDAK LAGI memanggil `s3Client`/AWS SDK
 * secara langsung (sebelumnya begitu sejak Phase 4) — sekarang lewat
 * `objectStorageProvider`, yang bisa diganti ke implementasi lain
 * (mis. disk lokal untuk development, lihat
 * `OBJECT_STORAGE_PROVIDER`) tanpa mengubah satu baris pun di sini.
 *
 * Phase 4 upgrade: SETIAP upload sekarang juga dicatat ke
 * `FileUpload` (lewat `UploadRepository`) supaya ada kepemilikan yang
 * bisa ditegakkan untuk "Access"/"Delete" — sebelumnya file hanya ke
 * S3 tanpa jejak apa pun di database, jadi tidak mungkin membedakan
 * "ini file saya" dari "ini file orang lain".
 */
export class UploadService {
  constructor(private readonly uploadRepository: UploadRepository) {}

  async uploadFile(
    file: {
      buffer: Buffer;
      mimetype: string;
      originalname: string;
    },
    userId: string
  ): Promise<UploadedFileDto> {
    // Nama file ASLI dari client TIDAK PERNAH dipakai langsung sebagai
    // S3 key — mencegah path traversal (`../../etc/passwd`) maupun
    // tabrakan nama antar-upload dari user berbeda. Hanya ekstensinya
    // yang diambil dari nama asli, sisanya UUID acak.
    const extension = path.extname(file.originalname);

    // Finding #18 (P1 Security Hardening) — SEBELUM ini, `mimetype`
    // hanya dicek terhadap allowlist di `upload.middleware.ts`
    // (`fileFilter`), TAPI nilai itu murni klaim dari client
    // (multipart `Content-Type`), sepenuhnya bisa dibohongi tanpa
    // hubungan apa pun dengan isi file sesungguhnya. Di sini, byte
    // PERTAMA `file.buffer` yang SUNGGUHAN diterima (tidak bisa
    // dipalsukan lewat header request) dicocokkan terhadap magic
    // bytes standar tiap format — lapis kedua yang independen dari
    // klaim client.
    if (!matchesFileSignature(file.buffer, file.mimetype)) {
      throw new BadRequestError(`Isi file tidak cocok dengan tipe yang diklaim (${file.mimetype})`);
    }

    const key = `uploads/${randomUUID()}${extension}`;

    const { url } = await objectStorageProvider.upload({
      key,
      body: file.buffer,
      contentType: file.mimetype,
    });

    const record = await this.uploadRepository.create({
      key,
      url,
      originalName: file.originalname,
      mimetype: file.mimetype,
      sizeBytes: file.buffer.length,
      userId,
    });

    return { id: record.id, url, key };
  }

  /**
   * "Access" — mengembalikan metadata file (bukan buffer/isi file;
   * `url` yang tersimpan sudah cukup untuk klien mengambil file
   * langsung dari S3). Otorisasi kepemilikan identik dengan
   * `EventService`/`ProductService`: pemilik ATAU requester dengan
   * `upload.moderate`.
   */
  async getFile(id: string, requester: RequesterContext): Promise<FileMetadataDto> {
    const file = await this.uploadRepository.findById(id);
    if (!file) {
      throw new NotFoundError('File tidak ditemukan');
    }

    this.assertCanAccess(file.userId, requester);

    return this.toMetadataDto(file);
  }

  /**
   * Hapus file dari S3 DAN baris metadatanya — dalam urutan itu
   * (S3 dulu, baru DB). Kalau penghapusan S3 gagal (network/permission
   * error), `delete()` di database SENGAJA tidak ikut dieksekusi —
   * lebih aman menyisakan metadata "yatim" yang bisa diselidiki/dicoba
   * ulang, dibanding baris DB terhapus tapi objek S3-nya masih ada
   * (file akan bocor selamanya, tidak pernah bisa ditemukan lagi
   * lewat aplikasi).
   */
  async deleteFile(id: string, requester: RequesterContext): Promise<void> {
    const file = await this.uploadRepository.findById(id);
    if (!file) {
      throw new NotFoundError('File tidak ditemukan');
    }

    this.assertCanAccess(file.userId, requester);

    await objectStorageProvider.delete(file.key);

    await this.uploadRepository.delete(id);
  }

  private assertCanAccess(fileOwnerId: string, requester: RequesterContext): void {
    const isOwner = fileOwnerId === requester.id;
    const canModerate = hasPermission(requester.role, 'upload.moderate');
    if (!isOwner && !canModerate) {
      throw new ForbiddenError('Anda hanya bisa mengakses atau menghapus file milik Anda sendiri');
    }
  }

  private toMetadataDto(file: {
    id: string;
    url: string;
    originalName: string;
    mimetype: string;
    sizeBytes: number;
    userId: string;
    createdAt: Date;
  }): FileMetadataDto {
    return {
      id: file.id,
      url: file.url,
      originalName: file.originalName,
      mimetype: file.mimetype,
      sizeBytes: file.sizeBytes,
      userId: file.userId,
      createdAt: file.createdAt,
    };
  }
}
