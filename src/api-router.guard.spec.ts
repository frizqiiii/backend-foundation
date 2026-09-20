import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

/**
 * Fase 2 (temuan T8) — PENJAGA: setiap router API berversi harus dibuat lewat `createApiRouter()`.
 *
 * `generalRateLimiter` dan `tenantRateLimiter` dipasang DI DALAM router versi (lewat
 * `createApiRouter()`), bukan di level `app`. Router `/api/v2` yang dibuat dengan `Router()` polos
 * tidak akan terlindungi rate limit dan tidak ada error yang memberitahu. Test ini memindai `app.ts`
 * (AST TypeScript) dan GAGAL kalau:
 *  - ada `app.use('/api/vN', X)` yang X-nya bukan panggilan `createVNRouter()`, atau
 *  - fungsi `createVNRouter` tidak memanggil `createApiRouter()`, atau
 *  - fungsi `createVNRouter` membuat `Router()` polos.
 *
 * Keterbatasan (jujur): ini pemeriksaan struktural di `app.ts` saja — router yang dipasang lewat
 * jalur lain (mis. file lain, atau `app.use` dengan variabel) tidak terlihat. Perilaku sebenarnya
 * dibuktikan terpisah oleh `app.api-router.integration.spec.ts`.
 */
const APP_FILE = path.resolve(__dirname, 'app.ts');

function parse(): ts.SourceFile {
  return ts.createSourceFile(
    APP_FILE,
    fs.readFileSync(APP_FILE, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
}

interface Mount {
  version: string;
  factoryName: string | null;
  line: number;
}

function collectMounts(sf: ts.SourceFile): Mount[] {
  const mounts: Mount[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'use' &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const match = /^\/api\/(v\d+)$/.exec(node.arguments[0].text);
      if (match) {
        const second = node.arguments[1];
        const factoryName =
          ts.isCallExpression(second) && ts.isIdentifier(second.expression)
            ? second.expression.text
            : null;
        mounts.push({
          version: match[1],
          factoryName,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mounts;
}

function findFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sf.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name
  );
}

function callsInside(node: ts.Node, calleeName: string): number {
  let count = 0;
  const visit = (child: ts.Node): void => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === calleeName
    ) {
      count += 1;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return count;
}

describe('Router API berversi harus dibuat lewat createApiRouter() (temuan T8)', () => {
  const sf = parse();
  const mounts = collectMounts(sf);

  it('pemindai menemukan mount `/api/vN` (bukan lolos karena tidak menemukan apa-apa)', () => {
    expect(mounts.length).toBeGreaterThanOrEqual(1);
  });

  it.each(mounts.map((mount) => [mount.version, mount] as const))(
    'mount /api/%s memakai createVNRouter() dan factory itu dimulai dari createApiRouter()',
    (version, mount) => {
      const expectedFactory = `create${version.toUpperCase()}Router`;
      expect(mount.factoryName).toBe(expectedFactory);

      const factory = findFunction(sf, expectedFactory);
      expect(factory).toBeDefined();
      // Wajib memanggil createApiRouter() (tepat sekali) dan TIDAK membuat Router() polos.
      expect(callsInside(factory as ts.FunctionDeclaration, 'createApiRouter')).toBe(1);
      expect(callsInside(factory as ts.FunctionDeclaration, 'Router')).toBe(0);
    }
  );

  it('createApiRouter() sendiri memasang generalRateLimiter DAN tenantRateLimiter', () => {
    const factory = findFunction(sf, 'createApiRouter') as ts.FunctionDeclaration;
    expect(factory).toBeDefined();
    const text = factory.getText(sf);
    expect(text).toMatch(/\.use\(\s*generalRateLimiter\s*\)/);
    expect(text).toMatch(/\.use\(\s*tenantRateLimiter\s*\)/);
  });
});
