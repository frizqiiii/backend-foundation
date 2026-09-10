describe('logger (Pino config)', () => {
  async function loadWithSpan(
    span: { spanContext: () => { traceId: string; spanId: string } } | undefined
  ) {
    let capturedOptions: { mixin: () => Record<string, string> } | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('pino', () => {
        const pinoMock = jest.fn().mockImplementation((options) => {
          capturedOptions = options;
          return { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
        });
        return { __esModule: true, default: pinoMock };
      });
      jest.doMock('@opentelemetry/api', () => ({
        trace: { getSpan: jest.fn().mockReturnValue(span) },
        context: { active: jest.fn() },
      }));
      require('./logger');
    });
    return capturedOptions!;
  }

  it('P5 — mixin() mengembalikan objek kosong kalau TIDAK ada span OTel aktif (mis. OTEL_ENABLED=false, atau saat test)', async () => {
    const options = await loadWithSpan(undefined);

    expect(options.mixin()).toEqual({});
  });

  it('P5 — mixin() menyisipkan trace_id/span_id kalau ADA span OTel aktif', async () => {
    const fakeSpan = {
      spanContext: () => ({ traceId: 'trace-abc', spanId: 'span-xyz' }),
    };
    const options = await loadWithSpan(fakeSpan);

    expect(options.mixin()).toEqual({ trace_id: 'trace-abc', span_id: 'span-xyz' });
  });

  it('P5 — level "silent" saat NODE_ENV=test (mencegah noise di output test)', async () => {
    let capturedOptions: { level: string } | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('pino', () => {
        const pinoMock = jest.fn().mockImplementation((options) => {
          capturedOptions = options;
          return {};
        });
        return { __esModule: true, default: pinoMock };
      });
      jest.doMock('./config/env', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'info' } }));
      require('./logger');
    });

    expect(capturedOptions!.level).toBe('silent');
  });

  it('P5 — transport pino-pretty HANYA diaktifkan saat NODE_ENV=development', async () => {
    let capturedOptions: { transport?: unknown } | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('pino', () => {
        const pinoMock = jest.fn().mockImplementation((options) => {
          capturedOptions = options;
          return {};
        });
        return { __esModule: true, default: pinoMock };
      });
      jest.doMock('./config/env', () => ({ env: { NODE_ENV: 'development', LOG_LEVEL: 'info' } }));
      require('./logger');
    });

    expect(capturedOptions!.transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    });
  });

  it('P5 — level mengikuti env.LOG_LEVEL di production (bukan silent)', async () => {
    let capturedOptions: { level: string; transport?: unknown } | undefined;
    await jest.isolateModulesAsync(async () => {
      jest.doMock('pino', () => {
        const pinoMock = jest.fn().mockImplementation((options) => {
          capturedOptions = options;
          return {};
        });
        return { __esModule: true, default: pinoMock };
      });
      jest.doMock('./config/env', () => ({ env: { NODE_ENV: 'production', LOG_LEVEL: 'warn' } }));
      require('./logger');
    });

    expect(capturedOptions!.level).toBe('warn');
    expect(capturedOptions!.transport).toBeUndefined();
  });
});
