import { keyPrefix } from './cache.metrics';

describe('cache.metrics', () => {
  describe('keyPrefix', () => {
    it('mengambil segmen sebelum separator ":" pertama', () => {
      expect(keyPrefix('feature-flags:tenant-abc')).toBe('feature-flags');
    });

    it('mengambil segmen sebelum ":" PERTAMA saja, bukan yang terakhir (key dengan banyak segmen)', () => {
      expect(keyPrefix('events:list:page-2:category-tech')).toBe('events');
    });

    it('mengembalikan key apa adanya kalau tidak ada separator ":" sama sekali', () => {
      expect(keyPrefix('single-segment-key')).toBe('single-segment-key');
    });
  });
});
