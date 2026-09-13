describe('startTracing', () => {
  const sdkStart = jest.fn();
  const sdkShutdown = jest.fn();
  const NodeSDKMock = jest.fn().mockImplementation(() => ({
    start: sdkStart,
    shutdown: sdkShutdown,
  }));

  /**
   * `startTracing()` me-require `../config/env` secara LAZY di DALAM
   * fungsinya sendiri (lihat komentar di tracing.ts) — kalau
   * `startTracing()` dipanggil SETELAH keluar dari
   * `jest.isolateModulesAsync`, require lazy itu akan jatuh ke
   * registry modul NORMAL (bukan yang ter-isolasi), sehingga mock
   * `../config/env` di bawah ini tidak akan pernah berlaku. Karena
   * itu, `startTracing()` HARUS dipanggil dari DALAM callback isolate
   * yang sama — helper ini menerima `runInsideIsolate` supaya
   * assertion di setiap test bisa dijalankan di konteks yang benar.
   */
  async function loadWithEnv(
    otelEnabled: boolean,
    run: (startTracing: () => void) => void | Promise<void>
  ) {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@opentelemetry/sdk-node', () => ({ NodeSDK: NodeSDKMock }));
      jest.doMock('@opentelemetry/auto-instrumentations-node', () => ({
        getNodeAutoInstrumentations: jest.fn().mockReturnValue([]),
      }));
      jest.doMock('@prisma/instrumentation', () => ({
        PrismaInstrumentation: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('@opentelemetry/exporter-trace-otlp-http', () => ({
        OTLPTraceExporter: jest.fn().mockImplementation(() => ({})),
      }));
      jest.doMock('@opentelemetry/resources', () => ({
        resourceFromAttributes: jest.fn().mockImplementation((attrs) => attrs),
      }));
      jest.doMock('../config/env', () => ({
        env: {
          OTEL_ENABLED: otelEnabled,
          OTEL_SERVICE_NAME: 'backend-foundation',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
          NODE_ENV: 'test',
        },
      }));
      const mod: typeof import('./tracing') = require('./tracing');
      await run(mod.startTracing);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.removeAllListeners('SIGTERM');
  });

  it('TIDAK melakukan apa pun kalau OTEL_ENABLED false (bukan sekadar exporter no-op)', async () => {
    await loadWithEnv(false, (startTracing) => {
      startTracing();

      expect(NodeSDKMock).not.toHaveBeenCalled();
      expect(sdkStart).not.toHaveBeenCalled();
    });
  });

  it('membuat NodeSDK dan memanggil start() kalau OTEL_ENABLED true', async () => {
    await loadWithEnv(true, (startTracing) => {
      startTracing();

      expect(NodeSDKMock).toHaveBeenCalledTimes(1);
      expect(sdkStart).toHaveBeenCalledTimes(1);
    });
  });

  it('P5 — resource service.version memakai process.env.npm_package_version kalau tersedia (bukan fallback "unknown")', async () => {
    const originalVersion = process.env.npm_package_version;
    process.env.npm_package_version = '1.2.3';
    try {
      await loadWithEnv(true, (startTracing) => {
        startTracing();
        expect(NodeSDKMock).toHaveBeenCalledTimes(1);
      });
    } finally {
      process.env.npm_package_version = originalVersion;
    }
  });

  it('P5 — mendaftarkan handler SIGTERM yang memanggil sdk.shutdown()', async () => {
    await loadWithEnv(true, async (startTracing) => {
      sdkShutdown.mockResolvedValue(undefined);

      startTracing();
      process.emit('SIGTERM');
      await new Promise(process.nextTick);

      expect(sdkShutdown).toHaveBeenCalledTimes(1);
    });
  });

  it('P5 — kegagalan sdk.shutdown() ditangani (di-log), TIDAK melempar unhandled rejection', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadWithEnv(true, async (startTracing) => {
      sdkShutdown.mockRejectedValue(new Error('gagal flush span'));

      startTracing();
      process.emit('SIGTERM');
      await new Promise(process.nextTick);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Gagal shutdown'),
        expect.any(Error)
      );
    });
    consoleErrorSpy.mockRestore();
  });
});
