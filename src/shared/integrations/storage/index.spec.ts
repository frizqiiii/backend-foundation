describe('objectStorageProvider selection', () => {
  async function loadWithProvider(providerName: string) {
    let objectStorageProvider: unknown;
    let localStorageProvider: unknown;
    let s3StorageProvider: unknown;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../config/env', () => ({ env: { OBJECT_STORAGE_PROVIDER: providerName } }));
      ({ objectStorageProvider } = require('./index'));
      ({ localStorageProvider } = require('./local-storage.provider'));
      ({ s3StorageProvider } = require('./s3-storage.provider'));
    });
    return { objectStorageProvider, localStorageProvider, s3StorageProvider };
  }

  it('memilih localStorageProvider kalau OBJECT_STORAGE_PROVIDER=local', async () => {
    const { objectStorageProvider, localStorageProvider } = await loadWithProvider('local');

    expect(objectStorageProvider).toBe(localStorageProvider);
  });

  it('P5 — memilih s3StorageProvider untuk nilai lain (default), termasuk s3 eksplisit', async () => {
    const { objectStorageProvider, s3StorageProvider } = await loadWithProvider('s3');

    expect(objectStorageProvider).toBe(s3StorageProvider);
  });
});
