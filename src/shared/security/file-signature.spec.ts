import { matchesFileSignature } from './file-signature';

describe('matchesFileSignature', () => {
  it('menerima JPEG asli (byte FF D8 FF)', () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(matchesFileSignature(buffer, 'image/jpeg')).toBe(true);
  });

  it('menerima PNG asli', () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(matchesFileSignature(buffer, 'image/png')).toBe(true);
  });

  it('menerima GIF87a dan GIF89a', () => {
    expect(matchesFileSignature(Buffer.from('GIF87a...'), 'image/gif')).toBe(true);
    expect(matchesFileSignature(Buffer.from('GIF89a...'), 'image/gif')).toBe(true);
  });

  it('menerima WEBP asli (RIFF....WEBP)', () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]), // panjang file, tidak relevan
      Buffer.from('WEBP'),
    ]);
    expect(matchesFileSignature(buffer, 'image/webp')).toBe(true);
  });

  it('menerima PDF asli (%PDF)', () => {
    const buffer = Buffer.from('%PDF-1.4\n...');
    expect(matchesFileSignature(buffer, 'application/pdf')).toBe(true);
  });

  /**
   * Regression test UTAMA Finding #18 — skenario penyerang: file
   * BUKAN gambar sama sekali (di sini disimulasikan lewat header
   * executable Windows "MZ", tapi prinsipnya sama untuk isi
   * berbahaya apa pun) dikirim dengan `mimetype` DIBOHONGI menjadi
   * "image/png". SEBELUM fix ini, tidak ada cara mendeteksi ini
   * sama sekali — sekarang harus ditolak.
   */
  it('MENOLAK file yang isinya BUKAN gambar meski mimetype-nya dibohongi jadi image/png', () => {
    const fakeExecutableDisguisedAsPng = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // "MZ..." (header EXE Windows)
    expect(matchesFileSignature(fakeExecutableDisguisedAsPng, 'image/png')).toBe(false);
  });

  it('MENOLAK JPEG asli yang mimetype-nya dibohongi jadi application/pdf (tukar-menukar antar tipe yang diizinkan)', () => {
    const realJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(matchesFileSignature(realJpeg, 'application/pdf')).toBe(false);
  });

  it('MENOLAK (fail-closed) untuk mimetype di luar daftar yang dikenal, bukan meloloskannya', () => {
    expect(matchesFileSignature(Buffer.from('apa saja'), 'application/octet-stream')).toBe(false);
  });

  it('MENOLAK buffer yang lebih pendek dari signature (tidak crash / index-out-of-bounds)', () => {
    expect(matchesFileSignature(Buffer.from([0xff]), 'image/jpeg')).toBe(false);
  });
});
