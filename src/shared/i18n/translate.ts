import { EN_MESSAGES, EN_TEMPLATES } from './catalog.en';
import type { Locale } from './locale';

/**
 * Fase 2 (item 2.13 — i18n) — menerjemahkan pesan sumber (Indonesia)
 * ke locale tujuan. Aturan:
 *  - `id` (bahasa sumber) -> dikembalikan APA ADANYA, tanpa pencarian;
 *  - `en` -> kecocokan persis di `EN_MESSAGES`, lalu pola dinamis di
 *    `EN_TEMPLATES`;
 *  - tidak ketemu -> pesan asli dikembalikan (fallback ke Indonesia).
 *    Terjemahan yang hilang TIDAK PERNAH menjadi error di hot path;
 *    `catalog.spec.ts` yang menangkapnya di CI.
 */

interface CompiledTemplate {
  regex: RegExp;
  /** Nomor penampung `{n}` untuk tiap grup tangkapan, urut kemunculan di teks Indonesia. */
  order: number[];
  target: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTemplate(source: string, target: string): CompiledTemplate {
  const order: number[] = [];
  const parts = source.split(/\{(\d+)\}/);
  const pattern = parts
    .map((part, index) => {
      if (index % 2 === 0) {
        return escapeRegExp(part);
      }
      order.push(Number(part));
      return '([\\s\\S]+?)';
    })
    .join('');
  return { regex: new RegExp(`^${pattern}$`), order, target };
}

const COMPILED_TEMPLATES: readonly CompiledTemplate[] = EN_TEMPLATES.map(([source, target]) =>
  compileTemplate(source, target)
);

// Pesan API selalu pendek; melewati batas ini berarti bukan pesan kita
// (mis. teks dari pihak ketiga) — tidak perlu dicocokkan ke pola.
const MAX_TEMPLATE_MATCH_LENGTH = 600;

export function translateMessage(message: string, locale: Locale): string {
  if (locale === 'id') {
    return message;
  }

  const exact = EN_MESSAGES[message];
  if (exact !== undefined) {
    return exact;
  }

  if (message.length > MAX_TEMPLATE_MATCH_LENGTH) {
    return message;
  }
  for (const template of COMPILED_TEMPLATES) {
    const match = template.regex.exec(message);
    if (match) {
      const values: Record<number, string> = {};
      template.order.forEach((placeholder, index) => {
        values[placeholder] = match[index + 1];
      });
      return template.target.replace(/\{(\d+)\}/g, (_whole, n: string) => values[Number(n)] ?? '');
    }
  }
  return message;
}

/** Menerjemahkan seluruh pesan pada `fieldErrors` Zod (`{ field: [pesan, ...] }`). */
export function translateFieldErrors(
  fieldErrors: Record<string, string[] | undefined>,
  locale: Locale
): Record<string, string[] | undefined> {
  if (locale === 'id') {
    return fieldErrors;
  }
  const result: Record<string, string[] | undefined> = {};
  for (const [field, messages] of Object.entries(fieldErrors)) {
    result[field] = messages?.map((message) => translateMessage(message, locale));
  }
  return result;
}
