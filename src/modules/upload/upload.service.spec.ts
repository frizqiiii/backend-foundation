import { UploadService } from './upload.service';
import type { UploadRepository } from './upload.repository';
import type { RequesterContext } from './upload.service';
import { objectStorageProvider } from '../../shared/integrations/storage';
import { ForbiddenError, NotFoundError, BadRequestError } from '../../shared/utils/http-error';

/**
 * Phase 15 — `objectStorageProvider` (bukan `s3Client` langsung, lihat
 * `shared/integrations/storage/`) di-mock lewat factory eksplisit,
 * memastikan TIDAK ADA panggilan jaringan sungguhan ke provider
 * penyimpanan apa pun selama test berjalan, dan `UploadService` benar-
 * benar hanya bergantung pada interface `ObjectStorageProvider`
 * (bukan detail S3 lagi).
 */
jest.mock('../../shared/integrations/storage', () => ({
  objectStorageProvider: { upload: jest.fn(), delete: jest.fn() },
}));

const mockedUpload = objectStorageProvider.upload as jest.Mock;
const mockedDelete = objectStorageProvider.delete as jest.Mock;

describe('UploadService', () => {
  let uploadService: UploadService;
  let uploadRepository: jest.Mocked<UploadRepository>;

  const ownerId = 'user-123';
  const ownerRequester: RequesterContext = { id: ownerId, role: 'USER' };
  const adminRequester: RequesterContext = { id: 'admin-999', role: 'ADMIN' };
  const strangerRequester: RequesterContext = { id: 'stranger-1', role: 'USER' };

  const fakeFile = {
    // Finding #18 — sejak `uploadFile` memvalidasi magic bytes,
    // buffer di sini HARUS byte PNG asli (89 50 4E 47 ...), bukan
    // sekadar teks placeholder — kalau tidak, setiap test di bawah
    // yang memanggil `uploadFile` akan gagal duluan di validasi
    // signature sebelum sempat menguji apa pun yang sebenarnya
    // dites di masing-masing `it()`.
    buffer: Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Buffer.from('sisa-konten-palsu'),
    ]),
    mimetype: 'image/png',
    originalname: 'foto-produk.png',
  };

  const dbRecord = {
    id: 'upload-1',
    key: 'uploads/abc123.png',
    url: 'https://test-bucket.s3.ap-southeast-1.amazonaws.com/uploads/abc123.png',
    originalName: fakeFile.originalname,
    mimetype: fakeFile.mimetype,
    sizeBytes: fakeFile.buffer.length,
    userId: ownerId,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(() => {
    uploadRepository = {
      create: jest.fn(),
      findById: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<UploadRepository>;

    uploadService = new UploadService(uploadRepository);
    mockedUpload.mockReset().mockResolvedValue({ url: dbRecord.url });
    mockedDelete.mockReset().mockResolvedValue(undefined);
    uploadRepository.create.mockResolvedValue(dbRecord);
  });

  describe('uploadFile', () => {
    it('mengunggah buffer file lewat objectStorageProvider dengan key, body, dan contentType yang benar', async () => {
      await uploadService.uploadFile(fakeFile, ownerId);

      expect(mockedUpload).toHaveBeenCalledTimes(1);
      const [input] = mockedUpload.mock.calls[0];
      expect(input.body).toBe(fakeFile.buffer);
      expect(input.contentType).toBe(fakeFile.mimetype);
      expect(input.key).toEqual(expect.stringContaining('uploads/'));
    });

    it('TIDAK PERNAH memakai nama file asli sebagai storage key (mencegah path traversal/tabrakan nama)', async () => {
      const result = await uploadService.uploadFile(fakeFile, ownerId);

      expect(result.key).not.toContain('foto-produk');
      // Ekstensi dari nama asli tetap dipertahankan agar tipe file jelas.
      expect(result.key.endsWith('.png')).toBe(true);
    });

    it('mengembalikan URL yang dikembalikan objectStorageProvider apa adanya', async () => {
      const result = await uploadService.uploadFile(fakeFile, ownerId);

      expect(result.url).toBe(dbRecord.url);
    });

    it('menghasilkan key yang unik untuk setiap upload, walau nama file asli sama', async () => {
      const first = await uploadService.uploadFile(fakeFile, ownerId);
      uploadRepository.create.mockResolvedValueOnce({ ...dbRecord, key: 'uploads/other.png' });
      const second = await uploadService.uploadFile(fakeFile, ownerId);

      expect(first.key).not.toBe(second.key);
    });

    it('mencatat kepemilikan file (userId) ke UploadRepository, DAN mengembalikan id record-nya', async () => {
      const result = await uploadService.uploadFile(fakeFile, ownerId);

      expect(uploadRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: ownerId, originalName: fakeFile.originalname })
      );
      expect(result.id).toBe(dbRecord.id);
    });

    /**
     * Regression test Finding #18 (end-to-end lewat `uploadFile`,
     * bukan cuma fungsi utility `matchesFileSignature` yang sudah
     * diuji terpisah di `file-signature.spec.ts`) — memastikan
     * `UploadService` benar-benar MENOLAK upload sebelum menyentuh
     * storage provider maupun repository sama sekali ketika isi file
     * tidak cocok dengan `mimetype` yang diklaim.
     */
    it('menolak upload (BadRequestError) ketika isi file TIDAK COCOK dengan mimetype yang diklaim, TANPA menyentuh storage/repository', async () => {
      const fileWithSpoofedMimetype = {
        buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]), // header EXE Windows ("MZ..."), bukan PNG sama sekali
        mimetype: 'image/png',
        originalname: 'foto-produk.png',
      };

      await expect(uploadService.uploadFile(fileWithSpoofedMimetype, ownerId)).rejects.toThrow(
        BadRequestError
      );
      expect(mockedUpload).not.toHaveBeenCalled();
      expect(uploadRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('getFile', () => {
    it('mengembalikan metadata ketika requester adalah pemilik file', async () => {
      uploadRepository.findById.mockResolvedValue(dbRecord);

      const result = await uploadService.getFile(dbRecord.id, ownerRequester);

      expect(result.id).toBe(dbRecord.id);
      expect(result.url).toBe(dbRecord.url);
    });

    it('mengembalikan metadata ketika requester ADMIN meski bukan pemilik (upload.moderate)', async () => {
      uploadRepository.findById.mockResolvedValue(dbRecord);

      const result = await uploadService.getFile(dbRecord.id, adminRequester);

      expect(result.id).toBe(dbRecord.id);
    });

    it('melempar ForbiddenError ketika requester BUKAN pemilik dan tidak punya upload.moderate', async () => {
      uploadRepository.findById.mockResolvedValue(dbRecord);

      await expect(uploadService.getFile(dbRecord.id, strangerRequester)).rejects.toThrow(
        ForbiddenError
      );
    });

    it('melempar NotFoundError ketika file tidak ditemukan', async () => {
      uploadRepository.findById.mockResolvedValue(null);

      await expect(uploadService.getFile('unknown-id', ownerRequester)).rejects.toThrow(
        NotFoundError
      );
    });
  });

  describe('deleteFile', () => {
    it('menghapus objek lewat objectStorageProvider (dengan key yang benar) DAN baris metadata ketika requester adalah pemilik', async () => {
      uploadRepository.findById.mockResolvedValue(dbRecord);

      await uploadService.deleteFile(dbRecord.id, ownerRequester);

      expect(mockedDelete).toHaveBeenCalledWith(dbRecord.key);
      expect(uploadRepository.delete).toHaveBeenCalledWith(dbRecord.id);
    });

    it('berhasil menghapus ketika requester ADMIN meski bukan pemilik (upload.moderate)', async () => {
      uploadRepository.findById.mockResolvedValue(dbRecord);

      await uploadService.deleteFile(dbRecord.id, adminRequester);

      expect(uploadRepository.delete).toHaveBeenCalledWith(dbRecord.id);
    });

    it('melempar ForbiddenError ketika requester BUKAN pemilik dan tidak punya upload.moderate, TIDAK menghapus apa pun', async () => {
      uploadRepository.findById.mockResolvedValue(dbRecord);

      await expect(uploadService.deleteFile(dbRecord.id, strangerRequester)).rejects.toThrow(
        ForbiddenError
      );
      expect(mockedDelete).not.toHaveBeenCalled();
      expect(uploadRepository.delete).not.toHaveBeenCalled();
    });

    it('melempar NotFoundError ketika file tidak ditemukan (atau sudah dihapus sebelumnya)', async () => {
      uploadRepository.findById.mockResolvedValue(null);

      await expect(uploadService.deleteFile('unknown-id', ownerRequester)).rejects.toThrow(
        NotFoundError
      );
      expect(mockedDelete).not.toHaveBeenCalled();
    });
  });
});
