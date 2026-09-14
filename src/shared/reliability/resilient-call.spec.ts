import { resilientCall, ResilientCallOptions } from './resilient-call';
import { withRetry } from './retry';
import { withBulkhead } from './bulkhead';
import { CircuitOpenError } from './circuit-breaker';

jest.mock('./retry', () => ({ withRetry: jest.fn() }));
jest.mock('./timeout', () => ({ withTimeout: jest.fn() }));
jest.mock('./circuit-breaker', () => {
  const actual = jest.requireActual('./circuit-breaker');
  return { ...actual, withCircuitBreaker: jest.fn() };
});
jest.mock('./bulkhead', () => ({ withBulkhead: jest.fn() }));

const mockedWithRetry = withRetry as jest.Mock;
const mockedWithBulkhead = withBulkhead as jest.Mock;

const baseOptions: ResilientCallOptions = {
  timeoutMs: 1000,
  retry: { attempts: 3, baseDelayMs: 100 },
  circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
  bulkhead: { maxConcurrent: 5, maxQueue: 10 },
};

describe('resilientCall — komposisi isRetryable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // `withBulkhead` di sini langsung memanggil fn (withRetries) yang
    // diberikan, supaya `withRetry` sungguhan (mock) terpanggil dan kita
    // bisa tangkap `options.isRetryable`-nya — ini SATU-SATUNYA hal yang
    // mau kita uji di sini (bukan perilaku bulkhead/circuit-breaker/timeout
    // itu sendiri, masing-masing sudah punya spec file terpisah).
    mockedWithBulkhead.mockImplementation((_key: string, fn: () => Promise<unknown>) => fn());
  });

  it('meneruskan isRetryable ke withRetry yang MENOLAK retry untuk CircuitOpenError, tapi MENGIZINKAN retry untuk error biasa', async () => {
    let capturedIsRetryable: ((error: unknown) => boolean) | undefined;
    mockedWithRetry.mockImplementation(
      async (
        _fn: () => Promise<unknown>,
        options: { isRetryable?: (error: unknown) => boolean }
      ) => {
        capturedIsRetryable = options.isRetryable;
        return 'ok';
      }
    );

    const result = await resilientCall('provider-key', async () => 'result', baseOptions);

    expect(result).toBe('ok');
    expect(capturedIsRetryable).toBeDefined();
    // Circuit breaker sudah tahu provider-nya sedang down — mengulang
    // percobaan di detik yang sama cuma buang waktu, breaker tidak akan
    // berubah status secepat itu.
    expect(capturedIsRetryable!(new CircuitOpenError('provider-key'))).toBe(false);
    // Error biasa (mis. network blip sementara) tetap layak di-retry.
    expect(capturedIsRetryable!(new Error('ECONNRESET'))).toBe(true);
  });
});
