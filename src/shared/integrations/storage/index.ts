import { env } from '../../config/env';
import type { ObjectStorageProvider } from './storage.provider';
import { s3StorageProvider } from './s3-storage.provider';
import { localStorageProvider } from './local-storage.provider';

export type { ObjectStorageProvider, UploadObjectInput } from './storage.provider';

function buildStorageProvider(): ObjectStorageProvider {
  return env.OBJECT_STORAGE_PROVIDER === 'local' ? localStorageProvider : s3StorageProvider;
}

export const objectStorageProvider: ObjectStorageProvider = buildStorageProvider();
