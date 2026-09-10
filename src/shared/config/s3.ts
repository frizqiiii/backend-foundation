import { S3Client } from '@aws-sdk/client-s3';
import { env } from './env';

/**
 * S3 Client sebagai singleton — pola yang sama seperti Prisma Client
 * di `database.ts`: satu instance dipakai ulang di seluruh aplikasi,
 * bukan dibuat baru di setiap request.
 */
export const s3Client = new S3Client({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});
