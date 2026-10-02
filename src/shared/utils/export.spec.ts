import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
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

/**
 * Ekstensi `extractPdfText`: selain isi teks, juga tangkap POSISI X dan Y
 * (dari operator `Tm`, sebelum tiap `Tj`/`TJ`) dan warna isi TERAKHIR
 * yang di-set sebelum teks itu (dari operator `scn` grayscale/RGB,
 * mengikuti `cs`). X dipakai untuk menutup mutant di
 * `columnWidth`/`startX` (posisi kolom salah = mutant kena) dan
 * `fillColor(...)` (warna salah = mutant kena). Y (Fase 3.5, T-mutation
 * id=288/307/308/309/310/311/312) dipakai untuk menutup mutant di logika
 * pagination `PAGE_BOTTOM_Y`/`doc.y > PAGE_BOTTOM_Y - 20` — verifikasi
 * ISI teks & JUMLAH content stream saja TIDAK CUKUP (dibuktikan: dengan
 * 200 baris, `PAGE_BOTTOM_Y` yang salah arah operatornya TETAP
 * menghasilkan >1 content stream karena `doc.y` terus bertambah tanpa
 * batas sampai akhirnya melewati ambang manapun — cuma TERLAMBAT,
 * dengan baris-baris yang sudah digambar jauh di luar batas halaman
 * yang SEBENARNYA sebelum itu).
 */
function extractPdfCells(
  buffer: Buffer
): Array<{ x: number; y: number; text: string; color: string | null }> {
  const raw = buffer.toString('latin1');
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const cells: Array<{ x: number; y: number; text: string; color: string | null }> = [];
  let match: RegExpExecArray | null;
  while ((match = streamRegex.exec(raw)) !== null) {
    let inflated: string;
    try {
      inflated = zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    let lastX: number | null = null;
    let lastY: number | null = null;
    let lastColor: string | null = null;
    for (const line of inflated.split('\n')) {
      const colorMatch =
        line.match(/^([\d.]+) \1 \1 scn$/) ?? line.match(/^([\d.]+) ([\d.]+) ([\d.]+) scn$/);
      if (colorMatch) {
        lastColor = line.trim();
        continue;
      }
      const tmMatch = line.match(/^[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ ([\d.-]+) ([\d.-]+) Tm$/);
      if (tmMatch) {
        lastX = parseFloat(tmMatch[1]);
        lastY = parseFloat(tmMatch[2]);
        continue;
      }
      const textMatch = line.match(/^<([0-9a-fA-F]+)> 0 T[jJ]$|^\[<([0-9a-fA-F]+)>.*?\] TJ$/);
      if (textMatch && lastX !== null && lastY !== null) {
        const hex = textMatch[1] || textMatch[2];
        cells.push({
          x: lastX,
          y: lastY,
          text: Buffer.from(hex, 'hex').toString('latin1'),
          color: lastColor,
        });
        lastX = null;
        lastY = null;
      }
    }
  }
  return cells;
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

  it('P5 — kolom PERSIS 3 (ID/Nama/Catatan) diposisikan berjarak columnWidth yang benar: (pageWidth - marginKiri - marginKanan) / jumlahKolom, MULAI dari marginKiri PERSIS — menutup mutant di perhitungan startX/columnWidth', async () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: 'X' }];
    const buffer = await toPdfBuffer(rows, columns, 'Judul');
    const cells = extractPdfCells(buffer);

    // Dimensi NYATA A4 landscape pdfkit: 841.89 x 595.28, margin 40 di
    // 4 sisi (dikonfirmasi lewat probe langsung ke pdfkit, bukan
    // ditebak) — dihitung dari geometri, bukan hardcode angka piksel.
    const PAGE_WIDTH = 841.89;
    const MARGIN = 40;
    const expectedColumnWidth = (PAGE_WIDTH - MARGIN - MARGIN) / columns.length;

    const idCell = cells.find((c) => c.text === 'ID');
    const namaCell = cells.find((c) => c.text === 'Nama');
    const catatanCell = cells.find((c) => c.text === 'Catatan');
    expect(idCell?.x).toBeCloseTo(MARGIN, 1); // startX PERSIS marginKiri
    expect(namaCell?.x).toBeCloseTo(MARGIN + expectedColumnWidth, 1);
    expect(catatanCell?.x).toBeCloseTo(MARGIN + expectedColumnWidth * 2, 1);

    // Baris DATA (bukan cuma header) juga harus sejajar dengan kolomnya
    const valueCell = cells.find((c) => c.text === 'Budi');
    expect(valueCell?.x).toBeCloseTo(MARGIN + expectedColumnWidth, 1);
  });

  it('P5 — baris "Dibuat: ... — Total baris" dirender abu-abu (fillColor("gray")), BUKAN warna default hitam yang dipakai header/data', async () => {
    const buffer = await toPdfBuffer([{ id: '1', name: 'Budi', note: 'X' }], columns, 'Judul');
    const cells = extractPdfCells(buffer);

    const dateLineCell = cells.find((c) => c.text.startsWith('Dib'));
    const headerCell = cells.find((c) => c.text === 'ID');

    // fillColor('gray') pdfkit -> RGB (0.502, 0.502, 0.502) — beda
    // jelas dari default/fillColor('black') -> (0, 0, 0).
    expect(dateLineCell?.color).toMatch(/^0\.50\d* 0\.50\d* 0\.50\d* scn$/);
    expect(headerCell?.color).not.toBe(dateLineCell?.color);
  });

  it('T-mutation (id=288/307/308/309/310/311/312) — SETIAP halaman baru yang dibuka lewat paginasi manual BENAR-BENAR mendapat header kolom digambar ulang (bukan cuma "halaman bertambah" — pdfkit PUNYA auto-pagination sendiri yang independen dari cek manual ini, dibuktikan terpisah; nilai SEBENARNYA dari blok manual ini adalah redraw header, dan itu yang harus diuji)', async () => {
    const manyRows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      id: String(i),
      name: `User ${i}`,
      note: `Catatan baris ke-${i}`,
    }));

    const buffer = await toPdfBuffer(manyRows, columns, 'Laporan Besar');
    const cells = extractPdfCells(buffer);
    const { contentStreamCount } = extractPdfText(buffer);

    const headerOccurrences = cells.filter((c) => c.text === 'ID').length;

    // Dibuktikan lewat instrumentasi langsung (di luar test ini): dengan
    // 60 baris & pengaturan halaman yang sama, paginasi manual yang
    // BENAR menembak PERSIS SEKALI (di baris ke-34, sebelum baris
    // terakhir habis) -> total 2 kemunculan header "ID" (halaman 1 +
    // halaman baru itu). Mutant `id=288` (PAGE_BOTTOM_Y arah salah)
    // membuat ambang batasnya jadi jauh di LUAR halaman (height+margin,
    // bukan height-margin) sehingga cek manual TIDAK PERNAH benar
    // sebelum baris terakhir selesai -> header CUMA muncul SATU KALI
    // walau expor tetap "berhasil" secara teknis (pdfkit auto-pagination
    // sendiri tetap menambah halaman kalau perlu, TAPI TANPA header).
    // `id=312` (blok pagination dikosongkan total) punya efek identik.
    // `id=307/308` (kondisi dipaksa true/false) juga akan membuat angka
    // ini salah drastis (false -> sama seperti di atas; true -> header
    // muncul di SETIAP baris, jauh lebih dari 2).
    expect(headerOccurrences).toBe(2);
    expect(contentStreamCount).toBeGreaterThan(1);
  });

  it('T-mutation (id=317) — value null TIDAK PERNAH menghasilkan teks apa pun di kolomnya (bukan cuma "bukan string literal null", tapi BENAR-BENAR tidak ada operator gambar teks sama sekali)', async () => {
    const rows: Row[] = [{ id: '1', name: 'Budi', note: null }];
    const buffer = await toPdfBuffer(rows, columns, 'Judul');
    const cells = extractPdfCells(buffer);

    // pdfkit TIDAK menerbitkan operator Tj/TJ sama sekali untuk string
    // kosong (dibuktikan terpisah) — jadi kolom "Catatan" baris ini
    // SEHARUSNYA tidak muncul di daftar cell sama sekali. Mutant
    // menggantinya dengan teks placeholder ("Stryker was here!")
    // yang JELAS akan muncul sebagai cell sungguhan kalau lolos.
    const PAGE_WIDTH = 841.89;
    const MARGIN = 40;
    const columnWidth = (PAGE_WIDTH - MARGIN - MARGIN) / columns.length;
    const catatanColumnX = MARGIN + columnWidth * 2;

    const cellAtCatatanColumn = cells.find(
      (c) => Math.abs(c.x - catatanColumnX) < 1 && c.text !== 'Catatan'
    );
    expect(cellAtCatatanColumn).toBeUndefined();
  });

  it('T-mutation (id=297/id=320) — teks yang PANJANG di kolom TENGAH (bukan kolom terakhir — lihat catatan di bawah) BENAR-BENAR membungkus mengikuti lebar KOLOM, bukan melebar sampai ke tepi halaman', async () => {
    // SENGAJA taruh teks panjang di kolom TENGAH ("name"), BUKAN kolom
    // terakhir ("note") — dicoba dulu dengan kolom terakhir dan GAGAL
    // mendiskriminasi: untuk kolom PALING KANAN, lebar SISA ke tepi
    // halaman (default pdfkit kalau `width` dihapus) kebetulan HAMPIR
    // SAMA PERSIS dengan columnWidth-nya sendiri (kebetulan angka —
    // 3 kolom rata lebar pas mengisi halaman) — jadi mutan `{}` di
    // kolom terakhir TIDAK BISA dibedakan dari aslinya. Kolom TENGAH
    // tidak punya kebetulan itu: lebar sisa ke tepi halaman jauh lebih
    // besar dari satu columnWidth.
    const rows: Row[] = [
      {
        id: '1',
        name: 'Nama yang sangat sangat sangat panjang sekali dan pasti tidak akan muat dalam satu baris kolom yang sempit ini sungguhan',
        note: 'x',
      },
    ];
    const buffer = await toPdfBuffer(rows, columns, 'Judul');
    const cells = extractPdfCells(buffer);

    const PAGE_WIDTH = 841.89;
    const MARGIN = 40;
    const columnWidth = (PAGE_WIDTH - MARGIN - MARGIN) / columns.length;
    const namaColumnX = MARGIN + columnWidth * 1;

    const namaCells = cells.filter((c) => Math.abs(c.x - namaColumnX) < 1 && c.text !== 'Nama');
    const distinctYValues = new Set(namaCells.map((c) => Math.round(c.y)));

    // Tanpa constraint `width` (options jadi `{}`), pdfkit menggambar
    // teks itu melebar sampai lebar SISA halaman (jauh lebih dari satu
    // columnWidth untuk kolom tengah) — dengan `width` yang benar,
    // teks sepanjang ini WAJIB terbungkus ke lebih dari satu baris.
    expect(distinctYValues.size).toBeGreaterThan(1);
  });

  it('T-mutation (id=297, jalur drawHeaderRow) — label HEADER kolom yang panjang juga membungkus mengikuti lebar kolom (bukan cuma sel data biasa)', async () => {
    const longHeaderColumns: ExportColumn<Row>[] = [
      { header: 'ID', value: (row) => row.id },
      {
        header: 'Nama Lengkap Kolom Ini Sengaja Dibuat Sangat Panjang Untuk Menguji Pembungkusan',
        value: (row) => row.name,
      },
      { header: 'Catatan', value: (row) => row.note ?? '' },
    ];
    const rows: Row[] = [{ id: '1', name: 'Budi', note: 'x' }];

    const buffer = await toPdfBuffer(rows, longHeaderColumns, 'Judul');
    const cells = extractPdfCells(buffer);

    const PAGE_WIDTH = 841.89;
    const MARGIN = 40;
    const columnWidth = (PAGE_WIDTH - MARGIN - MARGIN) / longHeaderColumns.length;
    const namaColumnX = MARGIN + columnWidth * 1;

    const headerCells = cells.filter((c) => Math.abs(c.x - namaColumnX) < 1 && c.text !== 'Budi');
    const distinctYValues = new Set(headerCells.map((c) => Math.round(c.y)));

    expect(distinctYValues.size).toBeGreaterThan(1);
  });

  it('T-mutation (id=287) — error stream internal PDFKit BENAR-BENAR membuat Promise dari toPdfBuffer reject (bukan diam-diam tergantung selamanya)', async () => {
    const emitSpy = jest.spyOn((PDFDocument as any).prototype, 'on');

    const promise = toPdfBuffer([{ id: '1', name: 'Budi', note: 'X' }], columns, 'Judul');

    // Ambil handler yang benar-benar didaftarkan untuk event 'error'
    // oleh toPdfBuffer, lalu panggil manual dengan error palsu — ini
    // menguji WIRING-nya (apakah 'error' benar-benar didaftarkan,
    // bukan string lain akibat mutant), bukan memaksa PDFKit sungguhan
    // gagal secara internal.
    const errorHandlerCall = emitSpy.mock.calls.find(([event]) => event === 'error');
    expect(errorHandlerCall).toBeDefined();
    const errorHandler = errorHandlerCall![1] as (err: Error) => void;

    const fakeError = new Error('PDFKit internal error (disimulasikan)');
    errorHandler(fakeError);

    await expect(promise).rejects.toThrow('PDFKit internal error (disimulasikan)');
    emitSpy.mockRestore();
  });
});
