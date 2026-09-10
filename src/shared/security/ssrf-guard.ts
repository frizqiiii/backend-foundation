import dns from 'node:dns';
import { isIP } from 'node:net';
import { BadRequestError } from '../utils/http-error';

const dnsLookup = dns.promises.lookup;

/**
 * SSRF Guard — dipakai untuk URL manapun yang berasal dari input user
 * dan akan dipanggil SENDIRI oleh server (bukan diteruskan ke browser
 * client), yaitu webhook endpoint (`WebhookService.register`,
 * `processWebhookDeliveryJob`). Tanpa ini, user terautentikasi bisa
 * mendaftarkan webhook yang menunjuk ke service internal atau cloud
 * metadata endpoint (`169.254.169.254`), dan worker aplikasi ini akan
 * memanggilnya atas nama sendiri — SSRF klasik (OWASP A10:2021 /
 * CWE-918).
 *
 * Dipanggil di DUA titik yang sengaja terpisah:
 * 1. `WebhookService.register` — menolak URL berbahaya sedini
 *    mungkin, sebelum tersimpan ke database.
 * 2. `processWebhookDeliveryJob` — dicek ULANG tepat sebelum request
 *    terkirim. Ini BUKAN duplikasi yang sia-sia: resolusi DNS bisa
 *    berbeda antara waktu registrasi dan waktu pengiriman (DNS
 *    rebinding — domain publik yang valid saat didaftarkan diubah
 *    pemiliknya untuk resolve ke IP internal beberapa saat kemudian).
 *    Mengecek ulang di titik pemanggilan sesungguhnya menutup celah
 *    itu; mengecek hanya sekali di registrasi tidak cukup.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Hostname yang JELAS menunjuk ke mesin lokal, ditolak tanpa perlu
// resolusi DNS — pemeriksaan murah sebagai lapisan pertama sebelum
// pemeriksaan IP (lookup) yang lebih mahal di bawah.
const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost'];
const BLOCKED_HOSTNAMES = new Set(['localhost']);

/**
 * Cek apakah sebuah alamat IPv4 (string) berada di range privat/
 * reserved/link-local — termasuk `169.254.169.254` (AWS/GCP/Azure
 * cloud metadata endpoint, target SSRF paling umum untuk mencuri
 * credential IAM instance).
 */
function isPrivateOrReservedIPv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) {
    return true; // format tidak dikenali — tolak, bukan diloloskan diam-diam
  }
  const [a, b] = octets;

  if (a === 127) return true; // loopback (127.0.0.0/8)
  if (a === 10) return true; // private (10.0.0.0/8)
  if (a === 172 && b >= 16 && b <= 31) return true; // private (172.16.0.0/12)
  if (a === 192 && b === 168) return true; // private (192.168.0.0/16)
  if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.0.0/16)
  if (a === 0) return true; // "this network" (0.0.0.0/8)
  if (a >= 224) return true; // multicast (224.0.0.0/4) + reserved (240.0.0.0/4)

  return false;
}

/**
 * Padanan IPv6 dari fungsi di atas — mencakup loopback (`::1`),
 * unique local address (`fc00::/7`, padanan IPv6 dari private IPv4),
 * dan link-local (`fe80::/10`, juga dipakai beberapa cloud provider
 * untuk metadata endpoint versi IPv6).
 */
function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — evaluasi bagian IPv4-nya, jangan sampai jadi
    // celah bypass (mis. `::ffff:169.254.169.254`).
    return isPrivateOrReservedIPv4(normalized.replace('::ffff:', ''));
  }
  const firstGroup = normalized.split(':')[0];
  const firstGroupNum = parseInt(firstGroup || '0', 16);
  if ((firstGroupNum & 0xfe00) === 0xfc00) return true; // fc00::/7 (unique local)
  if ((firstGroupNum & 0xffc0) === 0xfe80) return true; // fe80::/10 (link-local)

  return false;
}

function isPrivateOrReservedIp(ip: string): boolean {
  return isIP(ip) === 6 ? isPrivateOrReservedIPv6(ip) : isPrivateOrReservedIPv4(ip);
}

/**
 * Validasi utama — lempar `BadRequestError` (bukan diam-diam
 * meloloskan) kalau URL memakai skema selain http(s), hostname-nya
 * jelas lokal, atau salah satu IP hasil resolusi DNS-nya berada di
 * range privat/reserved/link-local.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError('URL tidak valid');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new BadRequestError('URL harus memakai skema http atau https');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new BadRequestError('URL menunjuk ke host yang tidak diizinkan');
  }

  // Kalau hostname sudah berupa literal IP (bukan domain), tidak
  // perlu resolusi DNS — cek langsung.
  if (isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      throw new BadRequestError('URL menunjuk ke alamat IP yang tidak diizinkan');
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new BadRequestError('Hostname tidak bisa di-resolve');
  }

  if (addresses.length === 0 || addresses.some((a) => isPrivateOrReservedIp(a.address))) {
    throw new BadRequestError('URL menunjuk ke alamat IP yang tidak diizinkan');
  }
}
