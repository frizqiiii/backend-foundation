import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';
import { EN_MESSAGES } from './catalog.en';
import { translateMessage } from './translate';

/**
 * Fase 2 (item 2.13 — i18n) — PENJAGA KELENGKAPAN katalog.
 *
 * Kelemahan utama katalog berbasis teks sumber: mengubah satu kata di
 * pesan Indonesia (atau menambah pesan baru) membuat terjemahannya
 * diam-diam hilang, dan pengguna `en` mendadak menerima Indonesia.
 * Test ini memindai seluruh kode produksi (AST TypeScript, bukan regex
 * teks) dan GAGAL kalau ada pesan yang belum punya terjemahan.
 *
 * Situs yang dipindai (sama dengan tempat pesan pengguna dibentuk):
 *  - argumen pesan `new XxxError(...)`,
 *  - argumen pesan `sendSuccess(res, kode, PESAN, ...)`,
 *  - argumen pertama `translateMessage(PESAN, locale)` (pesan yang diterjemahkan langsung),
 *  - pesan validasi Zod (`.min(n, 'pesan')`, `.email('pesan')`, dst.),
 *  - properti bernama `message`.
 *
 * KETERBATASAN (jujur): pesan yang dibentuk di luar situs-situs itu
 * (mis. lewat variabel/ternary/fungsi pembantu) TIDAK terlihat oleh test
 * ini — lihat `MANUAL_KEYS` di bawah untuk yang diketahui.
 */

const SRC_ROOT = path.resolve(__dirname, '../..');

/** Pesan yang SENGAJA tidak diterjemahkan, dengan alasannya. Cocok berdasarkan awalan teks. */
const INTENTIONALLY_UNTRANSLATED_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Validation failed', 'sudah berbahasa Inggris (dokumentasi OpenAPI)'],
  ['ExportService:', 'error wiring internal (developer), bukan pesan untuk pengguna API'],
  ['Audit log hash chain', 'log/error job terjadwal internal'],
  ['Format ciphertext', 'error internal enkripsi'],
  ['Tenant context tidak aktif', 'error pemrograman internal, disamarkan di production'],
  [
    'PrivacyRepository:',
    'error invariant internal (pengaman erasure T15), disamarkan sebagai 500 di production',
  ],
];

/** File yang pesannya internal (log job, provider pihak ketiga, health, antrean) — tidak sampai ke pengguna API. */
const INTERNAL_FILE_FRAGMENTS = [
  '/scheduler/jobs/',
  '/integrations/',
  'webhook-delivery.queue.ts',
  'health.controller.ts',
];

/**
 * Kunci katalog yang dibentuk di luar situs yang dipindai (ternary,
 * kondisional) sehingga tidak terlihat oleh pemindai, tapi memang ada di kode:
 *  - error-handler.ts: ternary `MulterError` (batas ukuran file),
 *  - oauth.service.ts: `Kode otorisasi GitHub tidak valid${...}` (bagian dasarnya).
 */
const MANUAL_KEYS = [
  'Ukuran file melebihi batas maksimal yang diizinkan',
  'Kode otorisasi GitHub tidak valid',
];

/** Pesan dinamis yang tercakup oleh kombinasi entri statis + pola (sampel pemindai tak bisa mencocokkannya). */
const DYNAMIC_COVERED_BY_MANUAL = ['Kode otorisasi GitHub tidak valid'];

interface Site {
  file: string;
  line: number;
  text: string;
  dynamic: boolean;
  sample: string;
}

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function readText(
  node: ts.Node,
  sf: ts.SourceFile
): { text: string; dynamic: boolean; sample: string } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { text: node.text, dynamic: false, sample: node.text };
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    let sample = node.head.text;
    for (const span of node.templateSpans) {
      text += `\${${span.expression.getText(sf)}}${span.literal.text}`;
      sample += `X${span.literal.text}`;
    }
    return { text, dynamic: true, sample };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = readText(node.left, sf);
    const right = readText(node.right, sf);
    if (left && right) {
      return {
        text: left.text + right.text,
        dynamic: left.dynamic || right.dynamic,
        sample: left.sample + right.sample,
      };
    }
  }
  return null;
}

const ZOD_METHODS = new Set([
  'min',
  'max',
  'length',
  'email',
  'url',
  'regex',
  'uuid',
  'nonempty',
  'gte',
  'lte',
  'gt',
  'lt',
  'int',
  'positive',
  'startsWith',
  'endsWith',
  'includes',
]);
const ZOD_FIRST_ARG_IS_MESSAGE = new Set(['nonempty', 'email', 'url', 'uuid', 'int', 'positive']);
const MESSAGE_PROPS = new Set(['message', 'required_error', 'invalid_type_error', 'error']);

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    const add = (node: ts.Node): void => {
      const read = readText(node, sf);
      if (read) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        sites.push({ file: file.split(path.sep).join('/'), line: line + 1, ...read });
      }
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        /Error$/.test(node.expression.text) &&
        node.arguments
      ) {
        const messageIndex = node.expression.text === 'HttpError' ? 1 : 0;
        if (node.arguments[messageIndex]) {
          add(node.arguments[messageIndex]);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'sendSuccess' &&
        node.arguments[2]
      ) {
        add(node.arguments[2]);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'translateMessage' &&
        node.arguments[0]
      ) {
        add(node.arguments[0]);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (ZOD_METHODS.has(method)) {
          node.arguments.slice(1).forEach(add);
          if (ZOD_FIRST_ARG_IS_MESSAGE.has(method)) {
            node.arguments.slice(0, 1).forEach(add);
          }
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        MESSAGE_PROPS.has(node.name.text)
      ) {
        add(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sites;
}

const isInternalFile = (file: string): boolean =>
  INTERNAL_FILE_FRAGMENTS.some((fragment) => file.includes(fragment));

const isIntentionallyUntranslated = (text: string): boolean =>
  INTENTIONALLY_UNTRANSLATED_PREFIXES.some(([prefix]) => text.startsWith(prefix));

describe('Katalog terjemahan en — kelengkapan terhadap kode (item 2.13)', () => {
  const sites = collectSites();

  it('pemindai menemukan situs pesan dalam jumlah yang masuk akal (bukan lolos karena tidak menemukan apa-apa)', () => {
    expect(sites.length).toBeGreaterThan(150);
  });

  it('SETIAP pesan statis di kode punya terjemahan en (atau masuk daftar pengecualian internal)', () => {
    const missing = sites
      .filter((site) => !site.dynamic)
      .filter((site) => !isInternalFile(site.file))
      .filter((site) => !isIntentionallyUntranslated(site.text))
      .filter((site) => EN_MESSAGES[site.text] === undefined)
      .map(
        (site) => `${site.file.replace(SRC_ROOT, 'src')}:${site.line}  ${JSON.stringify(site.text)}`
      );

    // Pesan gagal berisi daftar lengkap supaya mudah menambahkannya ke `catalog.en.ts`.
    expect(missing).toEqual([]);
  });

  it('SETIAP pesan dinamis (template ${...}) dikenali oleh salah satu pola (atau masuk daftar pengecualian)', () => {
    const missing = sites
      .filter((site) => site.dynamic)
      .filter((site) => !isInternalFile(site.file))
      .filter((site) => !isIntentionallyUntranslated(site.text))
      .filter((site) => !DYNAMIC_COVERED_BY_MANUAL.some((prefix) => site.sample.startsWith(prefix)))
      .filter((site) => translateMessage(site.sample, 'en') === site.sample)
      .map(
        (site) => `${site.file.replace(SRC_ROOT, 'src')}:${site.line}  ${JSON.stringify(site.text)}`
      );

    expect(missing).toEqual([]);
  });

  it('tidak ada entri katalog YATIM: setiap kunci statis masih ada di kode (pesan sumbernya belum diubah/dihapus)', () => {
    const staticTexts = new Set(sites.filter((site) => !site.dynamic).map((site) => site.text));
    const orphans = Object.keys(EN_MESSAGES).filter(
      (key) => !staticTexts.has(key) && !MANUAL_KEYS.includes(key)
    );

    expect(orphans).toEqual([]);
  });

  it('setiap terjemahan tidak kosong dan tidak sama dengan teks sumber (bukan entri tempelan)', () => {
    for (const [source, target] of Object.entries(EN_MESSAGES)) {
      expect(target.trim()).not.toBe('');
      expect(target).not.toBe(source);
    }
  });
});
