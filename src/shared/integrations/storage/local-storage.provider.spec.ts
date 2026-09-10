import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('localStorageProvider', () => {
  let tmpDir: string;
  let localStorageProvider: typeof import('./local-storage.provider').localStorageProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-storage-test-'));
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../config/env', () => ({ env: { LOCAL_STORAGE_DIR: tmpDir } }));
      ({ localStorageProvider } = require('./local-storage.provider'));
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('upload', () => {
    it('menulis file ke LOCAL_STORAGE_DIR dan mengembalikan URL /local-uploads/<key>', async () => {
      const result = await localStorageProvider.upload({
        key: 'foo.png',
        body: Buffer.from('data-gambar'),
        contentType: 'image/png',
      });

      expect(result).toEqual({ url: '/local-uploads/foo.png' });
      const written = await fs.readFile(path.join(tmpDir, 'foo.png'));
      expect(written.toString()).toBe('data-gambar');
    });

    it('P5 — membuat subfolder secara rekursif kalau key mengandung path bertingkat', async () => {
      const result = await localStorageProvider.upload({
        key: 'users/user-1/avatar.png',
        body: Buffer.from('avatar-bytes'),
        contentType: 'image/png',
      });

      expect(result).toEqual({ url: '/local-uploads/users/user-1/avatar.png' });
      const written = await fs.readFile(path.join(tmpDir, 'users/user-1/avatar.png'));
      expect(written.toString()).toBe('avatar-bytes');
    });
  });

  describe('delete', () => {
    it('menghapus file yang ada', async () => {
      const filePath = path.join(tmpDir, 'to-delete.png');
      await fs.writeFile(filePath, 'x');

      await localStorageProvider.delete('to-delete.png');

      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('P5 — idempotent: menghapus key yang TIDAK ADA sama sekali tidak melempar error', async () => {
      await expect(localStorageProvider.delete('tidak-ada.png')).resolves.toBeUndefined();
    });
  });
});
