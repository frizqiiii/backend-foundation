/**
 * Parser User-Agent ringan — SENGAJA tanpa dependency eksternal
 * (mis. `ua-parser-js`). `RefreshToken.userAgent` sudah menyimpan
 * string mentah sejak Phase 7; kolom database TIDAK perlu diubah
 * (browser/OS bukan fakta yang berubah setelah request dibuat, jadi
 * aman dihitung ulang saat DIBACA, bukan disimpan saat DITULIS) —
 * lihat pemakaiannya di `AuthService.listSessions`.
 *
 * Cakupan SENGAJA terbatas ke browser & OS populer yang relevan untuk
 * ditampilkan di UI "sesi aktif" (mis. "Chrome di Windows"), bukan
 * deteksi User-Agent lengkap seperti library dedicated — presisi
 * penuh (versi minor, engine rendering, dst) tidak dibutuhkan di sini.
 */
export interface ParsedUserAgent {
  browser: string | null;
  operatingSystem: string | null;
  /** Label gabungan siap-tampil, mis. "Chrome di Windows" atau "Perangkat tidak dikenal". */
  deviceName: string;
}

const BROWSER_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/edg\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/chrome|crios/i, 'Chrome'],
  [/firefox|fxios/i, 'Firefox'],
  [/safari/i, 'Safari'],
];

const OS_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/windows/i, 'Windows'],
  // iOS DIPERIKSA SEBELUM macOS (bukan cuma soal urutan array biasa):
  // string User-Agent iPhone/iPad ASLI mengandung teks "like Mac OS X"
  // (konvensi kompatibilitas resmi Apple, sudah ada sejak iOS generasi
  // awal — BUKAN kasus langka), jadi kalau macOS diperiksa duluan,
  // SEMUA sesi dari iPhone/iPad salah terdeteksi sebagai "macOS" di
  // UI "sesi aktif" (`AuthService.listSessions`). Bug produksi nyata
  // ini ketahuan lewat mutation testing (Fase 1 item 1.2) — sebelumnya
  // tidak ada test yang memakai string User-Agent iPhone/iPad ASLI
  // (cuma potongan generik "iphone"/"ipad" tanpa "Mac OS X" di
  // dalamnya), jadi tabrakan pola ini tidak pernah ketahuan.
  [/iphone|ipad|ios/i, 'iOS'],
  [/mac os x|macintosh/i, 'macOS'],
  [/android/i, 'Android'],
  [/linux/i, 'Linux'],
];

function match(patterns: ReadonlyArray<[RegExp, string]>, userAgent: string): string | null {
  const found = patterns.find(([pattern]) => pattern.test(userAgent));
  return found ? found[1] : null;
}

export function parseUserAgent(userAgent: string | null): ParsedUserAgent {
  if (!userAgent) {
    return { browser: null, operatingSystem: null, deviceName: 'Perangkat tidak dikenal' };
  }

  const browser = match(BROWSER_PATTERNS, userAgent);
  const operatingSystem = match(OS_PATTERNS, userAgent);

  const deviceName =
    browser && operatingSystem
      ? `${browser} di ${operatingSystem}`
      : (browser ?? operatingSystem ?? 'Perangkat tidak dikenal');

  return { browser, operatingSystem, deviceName };
}
