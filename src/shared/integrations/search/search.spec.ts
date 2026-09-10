jest.mock('../../config/database', () => ({ prisma: { searchDocument: {} } }));

describe('search provider factory', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('memilih postgresSearchProvider secara default', () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { searchProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { postgresSearchProvider } = require('./postgres-search.provider');
    expect(searchProvider).toBe(postgresSearchProvider);
  });

  it('memilih meilisearchSearchProvider kalau SEARCH_PROVIDER=meilisearch, TANPA butuh kredensial', () => {
    process.env.SEARCH_PROVIDER = 'meilisearch';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { searchProvider } = require('./index');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { meilisearchSearchProvider } = require('./meilisearch-search.provider');
    expect(searchProvider).toBe(meilisearchSearchProvider);
    delete process.env.SEARCH_PROVIDER;
  });
});

describe('meilisearchSearchProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('upsert mengirim POST array dokumen ke /indexes/:name/documents', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { meilisearchSearchProvider } = require('./meilisearch-search.provider');
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '{}' });
    global.fetch = mockFetch as never;

    await meilisearchSearchProvider.upsert('products', { id: 'p1', title: 'Keyboard' });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/indexes/products/documents');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual([{ id: 'p1', title: 'Keyboard' }]);
  });

  it('search mengembalikan hits dari response', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { meilisearchSearchProvider } = require('./meilisearch-search.provider');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ hits: [{ id: 'p1', title: 'Keyboard' }] }),
    }) as never;

    const result = await meilisearchSearchProvider.search('products', 'keyboard');

    expect(result).toEqual([{ id: 'p1', title: 'Keyboard' }]);
  });

  it('deleteDocument mengirim DELETE ke path dokumen', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { meilisearchSearchProvider } = require('./meilisearch-search.provider');
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = mockFetch as never;

    await meilisearchSearchProvider.deleteDocument('products', 'p1');

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('/indexes/products/documents/p1');
    expect(options.method).toBe('DELETE');
  });

  it('melempar error kalau Meilisearch mengembalikan status bukan 2xx', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { meilisearchSearchProvider } = require('./meilisearch-search.provider');
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: async () => 'Index not found' }) as never;

    await expect(meilisearchSearchProvider.search('unknown', 'x')).rejects.toThrow('404');
  });
});
