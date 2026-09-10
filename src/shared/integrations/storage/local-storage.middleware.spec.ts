import type { Application } from 'express';

describe('mountLocalStorage', () => {
  const loggerInfo = jest.fn();
  const appUse = jest.fn();

  async function loadModule(provider: string) {
    let mod: typeof import('./local-storage.middleware') | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../config/env', () => ({
        env: { OBJECT_STORAGE_PROVIDER: provider, LOCAL_STORAGE_DIR: '/tmp/uploads' },
      }));
      jest.doMock('../../logger', () => ({ logger: { info: loggerInfo } }));
      mod = require('./local-storage.middleware');
    });
    return mod!;
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('memasang rute static /local-uploads kalau OBJECT_STORAGE_PROVIDER=local', async () => {
    const { mountLocalStorage } = await loadModule('local');
    const app = { use: appUse } as unknown as Application;

    mountLocalStorage(app);

    expect(appUse).toHaveBeenCalledWith('/local-uploads', expect.any(Function));
    expect(loggerInfo).toHaveBeenCalledWith(
      { dir: '/tmp/uploads' },
      expect.stringContaining('Local storage provider aktif')
    );
  });

  it('P5 — TIDAK memasang apa pun kalau OBJECT_STORAGE_PROVIDER=s3 (default)', async () => {
    const { mountLocalStorage } = await loadModule('s3');
    const app = { use: appUse } as unknown as Application;

    mountLocalStorage(app);

    expect(appUse).not.toHaveBeenCalled();
    expect(loggerInfo).not.toHaveBeenCalled();
  });
});
