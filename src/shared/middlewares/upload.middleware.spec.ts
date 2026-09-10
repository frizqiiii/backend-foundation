import express from 'express';
import request from 'supertest';
import { upload } from './upload.middleware';
import { errorHandler } from './error-handler';

/**
 * Multer TIDAK mengekspos `fileFilter`/`limits` sebagai properti
 * publik yang bisa dipanggil langsung dari test — satu-satunya cara
 * menguji perilaku SUNGGUHAN (mimetype ditolak, ukuran file melebihi
 * batas) adalah lewat request multipart/form-data nyata ke sebuah
 * Express app kecil, mirip pola `app.integration.spec.ts` tapi hanya
 * untuk middleware ini saja (tidak butuh Prisma/database sama sekali).
 */
function buildTestApp() {
  const app = express();
  app.post('/upload', upload.single('file'), (req, res) => {
    res.status(200).json({ success: true, mimetype: req.file?.mimetype, size: req.file?.size });
  });
  app.use(errorHandler);
  return app;
}

describe('upload middleware (multer config)', () => {
  const app = buildTestApp();

  it('menerima file dengan mimetype yang diizinkan (image/png)', async () => {
    const res = await request(app).post('/upload').attach('file', Buffer.from('fake-png-bytes'), {
      filename: 'foto.png',
      contentType: 'image/png',
    });

    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe('image/png');
  });

  it('menerima application/pdf', async () => {
    const res = await request(app).post('/upload').attach('file', Buffer.from('%PDF-1.4'), {
      filename: 'dok.pdf',
      contentType: 'application/pdf',
    });

    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe('application/pdf');
  });

  it('P5 — menolak mimetype yang tidak diizinkan (mis. text/plain) dengan 400', async () => {
    const res = await request(app).post('/upload').attach('file', Buffer.from('plain text'), {
      filename: 'catatan.txt',
      contentType: 'text/plain',
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('tidak diizinkan');
  });

  it('P5 — menolak file yang melebihi batas 5MB', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    const res = await request(app)
      .post('/upload')
      .attach('file', oversized, { filename: 'besar.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('melebihi batas maksimal');
  });

  it('P5 — request tanpa file sama sekali: multer melewatkan tanpa error (validasi "wajib ada file" adalah tanggung jawab Controller, bukan middleware ini)', async () => {
    const res = await request(app).post('/upload');

    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBeUndefined();
  });
});
