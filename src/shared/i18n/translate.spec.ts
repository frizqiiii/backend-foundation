import { translateFieldErrors, translateMessage } from './translate';

describe('translateMessage (item 2.13)', () => {
  it('id (bahasa sumber) dikembalikan APA ADANYA — termasuk pesan yang ada di katalog', () => {
    expect(translateMessage('Email atau password salah', 'id')).toBe('Email atau password salah');
    expect(translateMessage('teks apa saja', 'id')).toBe('teks apa saja');
  });

  it('en: kecocokan persis di katalog statis', () => {
    expect(translateMessage('Email atau password salah', 'en')).toBe('Incorrect email or password');
    expect(translateMessage('Produk tidak ditemukan', 'en')).toBe('Product not found');
  });

  it('en: pesan yang tidak ada di katalog jatuh ke teks asli (BUKAN error)', () => {
    expect(translateMessage('Pesan yang belum pernah diterjemahkan', 'en')).toBe(
      'Pesan yang belum pernah diterjemahkan'
    );
    expect(translateMessage('', 'en')).toBe('');
  });

  it('en: pesan dinamis — nilai dari pesan Indonesia dipasang ulang di terjemahan', () => {
    expect(
      translateMessage('Terlalu banyak percobaan login gagal. Coba lagi dalam 7 menit.', 'en')
    ).toBe('Too many failed login attempts. Try again in 7 minutes.');
    expect(translateMessage("Tenant 'acme' tidak ditemukan", 'en')).toBe("Tenant 'acme' not found");
    expect(translateMessage('Aksi ini membutuhkan permission: product.delete', 'en')).toBe(
      'This action requires permission: product.delete'
    );
  });

  it('en: pola dengan DUA nilai memetakan keduanya ke tempat yang benar', () => {
    expect(
      translateMessage(
        'Tidak bisa upgrade dari FEATURED ke PREMIUM — kategori tujuan harus lebih tinggi dari kategori saat ini',
        'en'
      )
    ).toBe(
      'Cannot upgrade from FEATURED to PREMIUM — the target category must be higher than the current category'
    );
    expect(translateMessage('days harus berupa bilangan bulat antara 1-90', 'en')).toBe(
      'days must be an integer between 1-90'
    );
  });

  it('en: nilai yang mengandung karakter khusus regex tidak merusak pencocokan', () => {
    expect(
      translateMessage(
        'Origin https://a.example.com:8443/(x)[y]+z tidak diizinkan oleh kebijakan CORS',
        'en'
      )
    ).toBe('Origin https://a.example.com:8443/(x)[y]+z is not allowed by the CORS policy');
  });

  it('en: nilai pada pola dinamis boleh memuat teks apa saja (mis. deskripsi error dari IdP)', () => {
    expect(
      translateMessage(
        'Login SSO ditolak oleh identity provider: access_denied: user ditolak',
        'en'
      )
    ).toBe('SSO login was rejected by the identity provider: access_denied: user ditolak');
  });

  it('en: teks yang MIRIP pola tapi tidak persis tidak ikut diterjemahkan (pola berjangkar ^...$)', () => {
    const almost = 'Awalan: Terlalu banyak percobaan login gagal. Coba lagi dalam 7 menit.';
    expect(translateMessage(almost, 'en')).toBe(almost);
    const trailing = 'Terlalu banyak percobaan login gagal. Coba lagi dalam 7 menit. Tambahan';
    expect(translateMessage(trailing, 'en')).toBe(trailing);
  });

  it('en: pesan sangat panjang (bukan pesan kita) tidak dicocokkan ke pola dinamis', () => {
    const long = `Origin ${'a'.repeat(700)} tidak diizinkan oleh kebijakan CORS`;
    expect(translateMessage(long, 'en')).toBe(long);
  });
});

describe('translateFieldErrors', () => {
  const fieldErrors = {
    email: ['Format email tidak valid'],
    password: ['Password minimal 8 karakter', 'pesan asing'],
    kosong: undefined,
  };

  it('id -> objek yang sama, tidak diubah', () => {
    expect(translateFieldErrors(fieldErrors, 'id')).toBe(fieldErrors);
  });

  it('en -> tiap pesan diterjemahkan, yang tak dikenal tetap, undefined tetap undefined', () => {
    expect(translateFieldErrors(fieldErrors, 'en')).toEqual({
      email: ['Invalid email format'],
      password: ['Password must be at least 8 characters', 'pesan asing'],
      kosong: undefined,
    });
  });
});
