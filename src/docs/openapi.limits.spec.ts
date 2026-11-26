import * as apiKeysDocs from './openapi.api-keys.paths';
import * as webhooksDocs from './openapi.webhooks.paths';
import { createApiKeySchema } from '../modules/api-keys/api-key.dto';
import { createWebhookEndpointSchema } from '../modules/webhooks/webhook.dto';
import { WEBHOOK_EVENT_TYPE_LIST } from '../modules/webhooks/webhook.events';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

const get = (node: unknown, key: string): unknown => (isObject(node) ? node[key] : undefined);

/**
 * Mengambil skema properti `key` dari requestBody (application/json) di dokumentasi. Dicari dengan menelusuri
 * objeknya, bukan lewat nama ekspor atau path, supaya tes tidak ikut rusak kalau dokumentasinya dipindah.
 * Hanya requestBody yang dicari: properti bernama sama di skema respons tidak ikut terhitung.
 */
function requestBodyProperty(docs: object, key: string): Json {
  const found: Json[] = [];
  const walk = (node: unknown): void => {
    if (!isObject(node)) return;
    const body = get(node, 'requestBody');
    const schema = get(get(get(body, 'content'), 'application/json'), 'schema');
    const property = get(get(schema, 'properties'), key);
    if (isObject(property)) found.push(property);
    Object.values(node).forEach(walk);
  };
  walk(docs);
  if (found.length !== 1) {
    throw new Error(
      `properti request "${key}" ditemukan ${found.length}x di dokumentasi (harus tepat 1x)`
    );
  }
  return found[0];
}

const numberOf = (schema: Json, key: string): number => {
  const value = schema[key];
  if (typeof value !== 'number') throw new Error(`"${key}" tidak ada di dokumentasi`);
  return value;
};

/**
 * Angka di dokumentasi harus SAMA dengan batas yang benar-benar ditegakkan zod: tes ini mencoba tepat di batas
 * (diterima) dan satu di atasnya (ditolak), jadi dokumentasi dan validasi tidak bisa melenceng diam-diam.
 */
describe('batas ukuran di dokumentasi OpenAPI = batas yang ditegakkan zod', () => {
  it('scopes: maxItems adalah jumlah terbanyak yang diterima createApiKeySchema', () => {
    const max = numberOf(requestBodyProperty(apiKeysDocs, 'scopes'), 'maxItems');
    const accepts = (count: number): boolean =>
      createApiKeySchema.safeParse({
        name: 'k',
        scopes: Array.from({ length: count }, () => 'a'),
      }).success;

    expect(accepts(max)).toBe(true);
    expect(accepts(max + 1)).toBe(false);
  });

  it('scopes: maxLength per scope adalah panjang terpanjang yang diterima createApiKeySchema', () => {
    const items = requestBodyProperty(apiKeysDocs, 'scopes').items;
    if (!isObject(items)) throw new Error('items scopes tidak ada di dokumentasi');
    const max = numberOf(items, 'maxLength');
    const accepts = (length: number): boolean =>
      createApiKeySchema.safeParse({ name: 'k', scopes: ['a'.repeat(length)] }).success;

    expect(accepts(max)).toBe(true);
    expect(accepts(max + 1)).toBe(false);
  });

  it('eventTypes: minItems dan maxItems adalah batas jumlah yang diterima createWebhookEndpointSchema', () => {
    const schema = requestBodyProperty(webhooksDocs, 'eventTypes');
    const min = numberOf(schema, 'minItems');
    const max = numberOf(schema, 'maxItems');
    const accepts = (count: number): boolean =>
      createWebhookEndpointSchema.safeParse({
        url: 'https://example.com/hook',
        eventTypes: Array.from({ length: count }, () => WEBHOOK_EVENT_TYPE_LIST[0]),
      }).success;

    expect(accepts(min)).toBe(true);
    expect(accepts(min - 1)).toBe(false);
    expect(accepts(max)).toBe(true);
    expect(accepts(max + 1)).toBe(false);
  });
});
