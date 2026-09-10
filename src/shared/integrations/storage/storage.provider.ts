/**
 * Object Storage Provider (Phase 15 — Enterprise Integration). Sama
 * pola dengan provider lain di fase ini — `UploadService` HANYA
 * mengenal interface ini, tidak pernah tahu detail S3/disk lokal.
 */
export interface UploadObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface ObjectStorageProvider {
  /** Mengembalikan URL publik/dapat-diakses untuk objek yang baru
   * diunggah. */
  upload(input: UploadObjectInput): Promise<{ url: string }>;
  delete(key: string): Promise<void>;
}
