import type { Response } from 'express';
import { sendSuccess } from './response';

function createRes(locals?: Record<string, unknown>): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  if (locals) {
    (res as unknown as { locals: Record<string, unknown> }).locals = locals;
  }
  return res;
}

describe('sendSuccess', () => {
  it('membentuk envelope { success, message, data } dan status code yang diminta', () => {
    const res = createRes();

    sendSuccess(res, 201, 'Produk berhasil dibuat', { id: 1 });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Produk berhasil dibuat',
      data: { id: 1 },
    });
  });

  it('menyertakan meta hanya kalau diberikan', () => {
    const res = createRes();

    sendSuccess(res, 200, 'Daftar produk berhasil diambil', [], { total: 0 });

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'Daftar produk berhasil diambil',
      data: [],
      meta: { total: 0 },
    });
  });

  describe('item 2.13 — i18n', () => {
    it('res tanpa locals (mis. mock lama) -> default id, pesan apa adanya', () => {
      const res = createRes(undefined);

      sendSuccess(res, 200, 'Login berhasil', null);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Login berhasil' }));
    });

    it('locale id -> teks sumber apa adanya', () => {
      const res = createRes({ locale: 'id' });

      sendSuccess(res, 200, 'Login berhasil', null);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Login berhasil' }));
    });

    it('locale en -> message diterjemahkan; data dan meta TIDAK disentuh', () => {
      const res = createRes({ locale: 'en' });
      const data = { nama: 'Produk berhasil dibuat' }; // isi data yang kebetulan mirip pesan tidak boleh ikut berubah

      sendSuccess(res, 200, 'Login berhasil', data, { catatan: 'Login berhasil' });

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Login successful',
        data: { nama: 'Produk berhasil dibuat' },
        meta: { catatan: 'Login berhasil' },
      });
    });

    it('locale en, pesan tidak ada di katalog -> teks asli', () => {
      const res = createRes({ locale: 'en' });

      sendSuccess(res, 200, 'Pesan baru yang belum diterjemahkan', null);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Pesan baru yang belum diterjemahkan' })
      );
    });
  });
});
