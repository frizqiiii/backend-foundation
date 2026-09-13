import ExcelJS from 'exceljs';
import zlib from 'zlib';
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

/**
 * Ekstrak teks dari PDF TANPA dependency eksternal — cuma `zlib`
 * bawaan Node. Stream konten PDF (operator `Tj`/`TJ`) dikompresi
 * FlateDecode standar (zlib deflate) dan teksnya muncul sebagai hex
 * string di antara `<...>` (1 byte = 1 karakter untuk font simpel
 * non-Identity-H yang dipakai `pdfkit` secara default).
 *
 * KENAPA INI, BUKAN `pdf-parse`: sempat dicoba pakai `pdf-parse` untuk
 * tujuan yang sama — DIBATALKAN karena terbukti tidak konsisten
 * antar-environment (`bad XRef entry` di komputer user, padahal lolos
 * di sandbox; sudah di-cross-check dengan Poppler bahwa PDF-nya
 * sendiri valid, jadi murni ketidakstabilan library itu). Pendekatan
 * ini cuma pakai `zlib` (modul inti Node, deterministik, sama di semua
 * environment) + regex/hex-decode sederhana — tidak ada permukaan
 * untuk ketidakstabilan lintas-environment seperti itu.
 */
function extractPdfText(buffer: Buffer): { text: string; contentStreamCount: number } {
  const raw = buffer.toString('latin1');
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let combined = '';
  let contentStreamCount = 0;
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw)) !== null) {
    const streamData = Buffer.from(match[1], 'latin1');
    try {
      const inflated = zlib.inflateSync(streamData).toString('latin1');
      const hexStrings = inflated.match(/<([0-9a-fA-F]+)>/g);
      if (hexStrings) {
        contentStreamCount += 1;
        for (const hex of hexStrings) {
          combined += Buffer.from(hex.slice(1, -1), 'hex').toString('latin1');
        }
      }
    } catch {
      // Bukan stream FlateDecode (mis. data font biner) — lewati, bukan error.
    }
  }
  return { text: combined, contentStreamCount };
}

describe('toPdfBuffer', () => {
  it('menghasilkan buffer PDF valid (diawali magic bytes %PDF)', async () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: 'Catatan' }];

    const buffer = await toPdfBuffer(rows, columns, 'Laporan Data');

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('P5 — isi teks PDF (bukan cuma magic bytes) memuat judul, header kolom, nilai data, dan jumlah baris PERSIS', async () => {
    const rows: Row[] = [
      { id: '1', name: 'Budi', note: 'Catatan A' },
      { id: '2', name: 'Sari', note: 'Catatan B' },
    ];

    const buffer = await toPdfBuffer(rows, columns, 'Laporan Data Uji');
    const { text } = extractPdfText(buffer);

    expect(text).toContain('Laporan Data Uji'); // judul
    expect(text).toContain('Total baris: 2'); // ANGKA PERSIS, bukan cuma "ada teks"
    expect(text).toContain('ID');
    expect(text).toContain('Nama');
    expect(text).toContain('Catatan');
    expect(text).toContain('Budi');
    expect(text).toContain('Sari');
    expect(text).toContain('Catatan A');
    expect(text).toContain('Catatan B');
  });

  it('P5 — value null dirender sebagai string kosong (tidak melempar error, dan TIDAK memunculkan teks "null" literal di PDF)', async () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: null }];

    const buffer = await toPdfBuffer(rows, columns, 'Judul');
    const { text } = extractPdfText(buffer);

    expect(text).not.toContain('null');
    expect(text).toContain('Budi');
  });

  it('P5 — menangani banyak baris (memicu pagination manual doc.addPage()): benar-benar menghasilkan LEBIH DARI 1 content stream (≈ lebih dari 1 halaman), bukan cuma "tidak error"', async () => {
    const manyRows: Row[] = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      name: `User ${i}`,
      note: `Catatan baris ke-${i}`,
    }));

    const buffer = await toPdfBuffer(manyRows, columns, 'Laporan Besar');
    const { text, contentStreamCount } = extractPdfText(buffer);

    // Menutup mutant di kondisi `doc.y > PAGE_BOTTOM_Y - 20` (mis. jadi
    // `doc.y > 0` atau angka ambang lain) — kalau kondisi trigger
    // addPage() berubah, jumlah content stream aktual ikut berubah.
    expect(contentStreamCount).toBeGreaterThan(1);
    expect(text).toContain('User 0');
    expect(text).toContain('User 199');
    expect(text).toContain('Total baris: 200');
  });

  it('menghasilkan PDF valid kalau rows kosong (hanya header + judul, TEPAT 1 content stream, "Total baris: 0")', async () => {
    const buffer = await toPdfBuffer([], columns, 'Judul Kosong');
    const { text, contentStreamCount } = extractPdfText(buffer);

    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(contentStreamCount).toBe(1);
    expect(text).toContain('Judul Kosong');
    expect(text).toContain('Total baris: 0');
  });
});
