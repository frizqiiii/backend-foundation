import { runWithCorrelationId, getCorrelationId } from './correlation-id';

describe('correlation-id', () => {
  it('mengembalikan undefined kalau dipanggil di luar runWithCorrelationId', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('mengembalikan correlation ID yang di-set lewat runWithCorrelationId', () => {
    runWithCorrelationId('req-abc-123', () => {
      expect(getCorrelationId()).toBe('req-abc-123');
    });
  });

  it('tetap terbaca lewat rantai async (promise) yang dimulai di dalam context', async () => {
    await runWithCorrelationId('req-async-456', async () => {
      await Promise.resolve();
      expect(getCorrelationId()).toBe('req-async-456');
    });
  });

  it('tidak bocor ke pemanggilan lain yang berjalan di luar context-nya', () => {
    runWithCorrelationId('req-abc-123', () => {
      expect(getCorrelationId()).toBe('req-abc-123');
    });

    expect(getCorrelationId()).toBeUndefined();
  });

  it('context berbeda untuk dua request paralel tidak saling tertukar', async () => {
    const results: string[] = [];

    await Promise.all([
      runWithCorrelationId('req-A', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(`A:${getCorrelationId()}`);
      }),
      runWithCorrelationId('req-B', async () => {
        results.push(`B:${getCorrelationId()}`);
      }),
    ]);

    expect(results).toContain('A:req-A');
    expect(results).toContain('B:req-B');
  });
});
