import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from '../../config/s3';
import { env } from '../../config/env';
import type { ObjectStorageProvider, UploadObjectInput } from './storage.provider';

/**
 * Provider DEFAULT — implementasi ini sudah ada sejak Phase 4, di
 * sini HANYA DIPINDAHKAN (bukan ditulis ulang) supaya berada di balik
 * interface `ObjectStorageProvider` yang seragam dengan provider lain
 * di Phase 15. `UploadService` tidak lagi memanggil `s3Client`
 * langsung.
 */
export const s3StorageProvider: ObjectStorageProvider = {
  async upload(input: UploadObjectInput): Promise<{ url: string }> {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.AWS_S3_BUCKET_NAME,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      })
    );

    return {
      url: `https://${env.AWS_S3_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/${input.key}`,
    };
  },

  async delete(key: string): Promise<void> {
    await s3Client.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }));
  },
};
