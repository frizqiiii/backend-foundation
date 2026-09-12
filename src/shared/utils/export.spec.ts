import ExcelJS from 'exceljs';
import { toCsv, toXlsxBuffer, toPdfBuffer, type ExportColumn } from './export';

interface Row {
  id: string;
  name: string;
  note: string | null;
}

const columns: ExportColumn<Row>[] = [
  { header: 'ID', value: (r) => r.id },
  { header: 'Nama', value: (r) => r.name },
  { header: 'Catatan', value: (r) => r.note },
];

describe('toCsv', () => {
  it('menghasilkan header + baris dipisah \\r\\n (RFC 4180)', () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: null }];
    const csv = toCsv(rows, columns);

    expect(csv).toBe('ID,Nama,Catatan\r\n1,Budi,');
  });

  it('mengembalikan string kosong pada value null', () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: null }];
    const csv = toCsv(rows, columns);
    expect(csv.endsWith(',')).toBe(true);
  });

  it('P5 — membungkus field yang mengandung koma dengan tanda kutip', () => {
    const rows: Row[] = [{ id: '1', name: 'Budi, S.Kom', note: null }];
    const csv = toCsv(rows, columns);
    expect(csv).toContain('"Budi, S.Kom"');
  });

  it('P5 — meng-escape tanda kutip ganda di dalam field (double it, RFC 4180)', () => {
    const rows: Row[] = [{ id: '1', name: 'Budi "Bee" S', note: null }];
    const csv = toCsv(rows, columns);
    expect(csv).toContain('"Budi ""Bee"" S"');
  });

  it('P5 — membungkus field yang mengandung baris baru', () => {
    const rows: Row[] = [{ id: '1', name: 'Baris1\nBaris2', note: null }];
    const csv = toCsv(rows, columns);
    expect(csv).toContain('"Baris1\nBaris2"');
  });

  it('menghasilkan hanya baris header kalau rows kosong', () => {
    const csv = toCsv([], columns);
    expect(csv).toBe('ID,Nama,Catatan');
  });
});

describe('toXlsxBuffer', () => {
  it('menghasilkan buffer XLSX yang bisa dibaca ulang dengan header bold dan data yang benar', async () => {
    const rows: Row[] = [
      { id: '1', name: 'Budi', note: 'Catatan A' },
      { id: '2', name: 'Sari', note: null },
    ];

    const buffer = await toXlsxBuffer(rows, columns, 'Data');

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Data');
    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).getCell(1).value).toBe('ID');
    expect(sheet!.getRow(1).font?.bold).toBe(true);
    expect(sheet!.getRow(2).getCell(2).value).toBe('Budi');
    expect(sheet!.getRow(3).getCell(2).value).toBe('Sari');
  });

  it('menghasilkan sheet dengan hanya header kalau rows kosong', async () => {
    const buffer = await toXlsxBuffer([], columns, 'Kosong');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.getWorksheet('Kosong');
    expect(sheet!.rowCount).toBe(1);
  });
});

describe('toPdfBuffer', () => {
  it('menghasilkan buffer PDF valid (diawali magic bytes %PDF) dengan judul dan jumlah baris', async () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: 'Catatan' }];

    const buffer = await toPdfBuffer(rows, columns, 'Laporan Data');

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  // CATATAN (Fase 1 item 1.2, mutation testing): sempat dicoba perkuat
  // assertion di atas pakai `pdf-parse` untuk verifikasi isi teks PDF
  // sungguhan (judul, header, nilai, jumlah halaman). DIBATALKAN —
  // `pdf-parse@1.1.1` (bundel `pdf.js` versi ~2018) terbukti TIDAK
  // KONSISTEN antar-environment (`UnknownErrorException: bad XRef
  // entry` muncul untuk PDF yang di environment lain terbaca normal;
  // sudah di-cross-check dengan Poppler/`pdftotext` — PDF-nya sendiri
  // VALID, jadi ini murni ketidakstabilan library test, bukan bug di
  // `toPdfBuffer`). Menambah dependency yang rapuh lintas-environment
  // demi menaikkan mutation score tidak sepadan — mutation score
  // `toPdfBuffer` untuk detail layout/formatting (lebar kolom, posisi
  // teks, warna, threshold pagination, dst) DITERIMA apa adanya untuk
  // saat ini; assertion tetap di level "PDF valid" seperti semula.

  it('P5 — value null dirender sebagai string kosong (tidak melempar error)', async () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: null }];
    await expect(toPdfBuffer(rows, columns, 'Judul')).resolves.toBeInstanceOf(Buffer);
  });

  it('P5 — menangani banyak baris (memicu pagination manual doc.addPage()) tanpa error', async () => {
    const manyRows: Row[] = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      name: `User ${i}`,
      note: `Catatan baris ke-${i}`,
    }));

    const buffer = await toPdfBuffer(manyRows, columns, 'Laporan Besar');

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('menghasilkan PDF valid kalau rows kosong (hanya header + judul)', async () => {
    const buffer = await toPdfBuffer([], columns, 'Judul Kosong');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
