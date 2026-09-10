import dns from 'node:dns';
import { assertSafeOutboundUrl } from './ssrf-guard';

// `dns.promises.lookup` di-mock supaya test ini deterministik dan
// tidak butuh resolusi DNS sungguhan (yang tidak konsisten/tidak
// tersedia di lingkungan CI tanpa akses jaringan keluar) — pola sama
// dengan alasan `login-attempt-tracker.spec.ts` menguji jalur
// in-memory murni.
jest.mock('node:dns', () => ({
  promises: { lookup: jest.fn() },
}));

const mockedLookup = dns.promises.lookup as jest.Mock;

describe('ssrf-guard', () => {
  afterEach(() => {
    mockedLookup.mockReset();
  });

  it('menolak skema selain http/https', async () => {
    await expect(assertSafeOutboundUrl('ftp://example.com/hook')).rejects.toThrow(
      'URL harus memakai skema http atau https'
    );
  });

  it('menolak URL yang tidak valid sama sekali', async () => {
    await expect(assertSafeOutboundUrl('bukan-url')).rejects.toThrow('URL tidak valid');
  });

  it('menolak hostname localhost tanpa perlu resolusi DNS', async () => {
    await expect(assertSafeOutboundUrl('http://localhost:3000/hook')).rejects.toThrow(
      'URL menunjuk ke host yang tidak diizinkan'
    );
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('menolak hostname berakhiran .internal', async () => {
    await expect(assertSafeOutboundUrl('https://service.internal/hook')).rejects.toThrow(
      'URL menunjuk ke host yang tidak diizinkan'
    );
  });

  it('menolak literal IP loopback tanpa resolusi DNS', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1/hook')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('menolak literal IP cloud metadata endpoint (169.254.169.254)', async () => {
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
  });

  it('menolak domain yang resolve ke IP privat (10.0.0.0/8)', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://internal.example.com/hook')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
  });

  it('menolak domain yang salah satu hasil resolusinya privat (multi-A record)', async () => {
    mockedLookup.mockResolvedValue([
      { address: '203.0.113.10', family: 4 },
      { address: '192.168.1.1', family: 4 },
    ]);
    await expect(assertSafeOutboundUrl('https://mixed.example.com/hook')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
  });

  it('menolak IPv6 loopback (::1)', async () => {
    mockedLookup.mockResolvedValue([{ address: '::1', family: 6 }]);
    await expect(assertSafeOutboundUrl('https://ipv6-local.example.com/hook')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
  });

  it('menolak IPv6 unique local address (fc00::/7)', async () => {
    mockedLookup.mockResolvedValue([{ address: 'fd12:3456:789a::1', family: 6 }]);
    await expect(assertSafeOutboundUrl('https://ipv6-ula.example.com/hook')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
  });

  it('menolak IPv4-mapped IPv6 yang mengarah ke metadata endpoint', async () => {
    mockedLookup.mockResolvedValue([{ address: '::ffff:169.254.169.254', family: 6 }]);
    await expect(assertSafeOutboundUrl('https://mapped.example.com/hook')).rejects.toThrow(
      'URL menunjuk ke alamat IP yang tidak diizinkan'
    );
  });

  it('meloloskan domain publik yang resolve ke IP publik', async () => {
    mockedLookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    await expect(assertSafeOutboundUrl('https://public.example.com/hook')).resolves.toBeUndefined();
  });

  it('meloloskan literal IP publik tanpa perlu resolusi DNS', async () => {
    await expect(assertSafeOutboundUrl('http://203.0.113.10/hook')).resolves.toBeUndefined();
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('menolak kalau hostname gagal di-resolve sama sekali', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertSafeOutboundUrl('https://tidak-ada.example.invalid/hook')).rejects.toThrow(
      'Hostname tidak bisa di-resolve'
    );
  });
});
