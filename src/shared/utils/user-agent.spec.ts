/**
 * `user-agent.ts` sebelumnya TIDAK PUNYA spec sama sekali — 11 mutant
 * "killed" yang ada sebelumnya murni efek samping test modul LAIN
 * (mis. `AuthService.listSessions`) yang kebetulan memanggil
 * `parseUserAgent` secara tidak langsung. Ditemukan lewat mutation
 * testing (Fase 1 item 1.2): mutation score 28.21% (25 dari 36
 * mutant lolos).
 *
 * `BROWSER_PATTERNS`/`OS_PATTERNS` masing-masing berisi regex dengan
 * BEBERAPA alternatif (mis. `chrome|crios`, `firefox|fxios`) — kalau
 * cuma diuji SATU contoh string User-Agent generik, mutant yang
 * menghapus salah satu alternatif regex (mis. `chrome|crios` jadi
 * `chrome`) tetap LOLOS karena tidak ada test yang secara spesifik
 * mengandalkan alternatif itu. Spec ini SENGAJA menguji setiap
 * alternatif regex satu-satu dengan string User-Agent nyata.
 */
import { parseUserAgent } from './user-agent';

describe('parseUserAgent', () => {
  describe('input null/kosong', () => {
    it('User-Agent null menghasilkan deviceName "Perangkat tidak dikenal", browser & OS null', () => {
      expect(parseUserAgent(null)).toEqual({
        browser: null,
        operatingSystem: null,
        deviceName: 'Perangkat tidak dikenal',
      });
    });

    it('User-Agent string kosong ("") diperlakukan SAMA seperti null (falsy check)', () => {
      expect(parseUserAgent('')).toEqual({
        browser: null,
        operatingSystem: null,
        deviceName: 'Perangkat tidak dikenal',
      });
    });
  });

  describe('deteksi BROWSER — setiap alternatif regex diuji terpisah', () => {
    it.each<[string, string]>([
      ['Mozilla/5.0 Edg/120.0.0.0', 'Edge'],
      ['Mozilla/5.0 OPR/106.0.0.0', 'Opera'],
      ['Mozilla/5.0 Opera/9.80', 'Opera'],
      ['Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36', 'Chrome'],
      ['Mozilla/5.0 CriOS/120.0.0.0 Safari/604.1', 'Chrome'], // Chrome di iOS — alternatif "crios"
      ['Mozilla/5.0 Firefox/121.0', 'Firefox'],
      ['Mozilla/5.0 FxiOS/121.0', 'Firefox'], // Firefox di iOS — alternatif "fxios"
      ['Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1.15', 'Safari'],
    ])('User-Agent %s -> browser %s', (ua, expectedBrowser) => {
      expect(parseUserAgent(ua).browser).toBe(expectedBrowser);
    });

    it('urutan pemeriksaan browser BENAR: Edge (berbasis Chromium, mengandung "Chrome" JUGA di UA-nya) harus terdeteksi sebagai Edge, BUKAN Chrome', () => {
      const edgeUA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

      expect(parseUserAgent(edgeUA).browser).toBe('Edge');
    });

    it('User-Agent tanpa penanda browser mana pun -> browser null', () => {
      expect(parseUserAgent('SomeUnknownBot/1.0').browser).toBeNull();
    });
  });

  describe('deteksi OS — setiap alternatif regex diuji terpisah', () => {
    it.each<[string, string]>([
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'macOS'],
      ['Mozilla/5.0 (Macintosh; Intel MACINTOSH)', 'macOS'], // alternatif "macintosh" (tanpa "mac os x")
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Android'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iOS'],
      ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iOS'], // alternatif "ipad"
      ['Mozilla/5.0 (X11; Linux x86_64)', 'Linux'],
    ])('User-Agent %s -> OS %s', (ua, expectedOs) => {
      expect(parseUserAgent(ua).operatingSystem).toBe(expectedOs);
    });

    it('urutan pemeriksaan OS BENAR: Android (berbasis Linux, mengandung kata "Linux" JUGA di UA-nya) harus terdeteksi sebagai Android, BUKAN Linux', () => {
      const androidUA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36';

      expect(parseUserAgent(androidUA).operatingSystem).toBe('Android');
    });

    it('User-Agent tanpa penanda OS mana pun -> operatingSystem null', () => {
      expect(parseUserAgent('SomeUnknownBot/1.0').operatingSystem).toBeNull();
    });
  });

  describe('deviceName — format gabungan & fallback', () => {
    it('browser DAN OS terdeteksi -> deviceName "{browser} di {OS}" PERSIS (termasuk kata "di")', () => {
      const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0 Safari/537.36';

      expect(parseUserAgent(ua).deviceName).toBe('Chrome di Windows');
    });

    it('HANYA browser terdeteksi (OS tidak dikenali) -> deviceName = nama browser saja, TANPA kata "di"', () => {
      const ua = 'Chrome/120.0.0.0 (PlatformAnehTidakDikenal)';

      const result = parseUserAgent(ua);
      expect(result.browser).toBe('Chrome');
      expect(result.operatingSystem).toBeNull();
      expect(result.deviceName).toBe('Chrome');
    });

    it('HANYA OS terdeteksi (browser tidak dikenali) -> deviceName = nama OS saja, TANPA kata "di"', () => {
      const ua = 'SomeUnknownBrowser/1.0 (Windows NT 10.0)';

      const result = parseUserAgent(ua);
      expect(result.browser).toBeNull();
      expect(result.operatingSystem).toBe('Windows');
      expect(result.deviceName).toBe('Windows');
    });

    it('browser MAUPUN OS tidak terdeteksi -> deviceName "Perangkat tidak dikenal" (fallback terakhir dari rantai ??)', () => {
      const result = parseUserAgent('SomeCompletelyUnknownBot/1.0');

      expect(result.browser).toBeNull();
      expect(result.operatingSystem).toBeNull();
      expect(result.deviceName).toBe('Perangkat tidak dikenal');
    });
  });

  it('pencocokan regex TIDAK case-sensitive (flag /i tetap aktif)', () => {
    const ua = 'MOZILLA/5.0 (WINDOWS NT 10.0) CHROME/120.0.0.0';

    expect(parseUserAgent(ua)).toEqual({
      browser: 'Chrome',
      operatingSystem: 'Windows',
      deviceName: 'Chrome di Windows',
    });
  });
});
