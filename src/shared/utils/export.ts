import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

export interface ExportColumn<T> {
  header: string;
  /** Ekstrak nilai kolom dari satu baris data — fungsi, bukan cuma nama field, supaya bisa memformat (mis. `Date` -> string) di titik ini, bukan di pemanggil. */
  value: (row: T) => string | number | boolean | null;
}

/**
 * CSV dibangun MANUAL (bukan library) — format CSV cukup sederhana
 * untuk tidak butuh dependency tambahan, beda dari XLSX di bawah yang
 * format binary-nya genuinely kompleks (ZIP + XML). `escapeCsvField`
 * menangani SATU-SATUNYA bagian rawan dari CSV manual: field yang
 * mengandung koma/petik-dua/baris-baru harus dibungkus & di-escape,
 * atau file akan rusak dibuka Excel/Google Sheets.
 */
function escapeCsvField(value: string | number | boolean | null): string {
  const str = value === null ? '' : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const header = columns.map((col) => escapeCsvField(col.header)).join(',');
  const lines = rows.map((row) => columns.map((col) => escapeCsvField(col.value(row))).join(','));
  // `\r\n` (bukan `\n` saja) — standar RFC 4180 untuk CSV, memastikan
  // Excel di Windows membuka file ini tanpa masalah baris-terpisah.
  return [header, ...lines].join('\r\n');
}

export async function toXlsxBuffer<T>(
  rows: T[],
  columns: ExportColumn<T>[],
  sheetName: string
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = columns.map((col) => ({ header: col.header, key: col.header, width: 20 }));
  // Header BOLD — satu-satunya styling yang disengaja ditambahkan;
  // export ini untuk konsumsi data (dibuka lalu diolah lebih lanjut,
  // mis. di-pivot atau di-filter manual), bukan laporan visual yang
  // butuh styling ekstensif.
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    sheet.addRow(Object.fromEntries(columns.map((col) => [col.header, col.value(row)])));
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * PDF tabular sederhana (Phase 19 — Export Service) — TIDAK
 * dimaksudkan untuk pixel-perfect report design, tujuannya representasi
 * tabel data yang bisa dicetak/dibaca manusia (mis. dilampirkan ke
 * email, diarsipkan) — cakupan yang SAMA dengan `toCsv`/`toXlsxBuffer`
 * di atas (data untuk dikonsumsi, bukan laporan visual kompleks
 * dengan chart/branding). `pdfkit` dipakai langsung (bukan
 * HTML-to-PDF via Puppeteer/Chromium) — SENGAJA jauh lebih ringan
 * (tidak perlu men-spawn browser headless), sesuai untuk kebutuhan
 * "cetak tabel", bukan render halaman web kompleks.
 *
 * Paginasi otomatis: `pdfkit` TIDAK auto-wrap tabel ke halaman baru
 * seperti library dedicated (mis. `pdfmake`) — dicek manual lewat
 * `doc.y > PAGE_BOTTOM_Y` sebelum menulis tiap baris, `doc.addPage()`
 * dipanggil begitu mendekati batas bawah halaman.
 */
export async function toPdfBuffer<T>(
  rows: T[],
  columns: ExportColumn<T>[],
  title: string
): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  const donePromise = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const PAGE_BOTTOM_Y = doc.page.height - doc.page.margins.bottom;
  const columnWidth =
    (doc.page.width - doc.page.margins.left - doc.page.margins.right) / columns.length;
  const startX = doc.page.margins.left;

  function drawHeaderRow(): void {
    doc.font('Helvetica-Bold').fontSize(9);
    columns.forEach((col, i) => {
      doc.text(col.header, startX + i * columnWidth, doc.y, { width: columnWidth, ellipsis: true });
    });
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(8);
  }

  doc.font('Helvetica-Bold').fontSize(14).text(title, { align: 'left' });
  doc.moveDown();
  doc
    .fontSize(8)
    .fillColor('gray')
    .text(`Dibuat: ${new Date().toISOString()} — Total baris: ${rows.length}`);
  doc.moveDown();
  doc.fillColor('black');
  drawHeaderRow();

  for (const row of rows) {
    if (doc.y > PAGE_BOTTOM_Y - 20) {
      doc.addPage();
      drawHeaderRow();
    }
    const rowY = doc.y;
    columns.forEach((col, i) => {
      const value = col.value(row);
      doc.text(value === null ? '' : String(value), startX + i * columnWidth, rowY, {
        width: columnWidth,
        ellipsis: true,
      });
    });
    doc.moveDown(0.3);
  }

  doc.end();
  return donePromise;
}
