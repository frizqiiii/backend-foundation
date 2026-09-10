import type { Request, Response } from 'express';

const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerInfoMock = jest.fn();

jest.mock('../../../shared/logger', () => ({
  logger: { error: loggerErrorMock, warn: loggerWarnMock, info: loggerInfoMock },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handleAlertmanagerWebhook } = require('./alertmanager-webhook.controller');

function createMockReq(body: unknown, headers: Record<string, string> = {}): Request {
  return { body, headers } as unknown as Request;
}

function createMockRes(): Response & { json: jest.Mock; status: jest.Mock } {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response & { json: jest.Mock; status: jest.Mock };
}

describe('handleAlertmanagerWebhook', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('mencatat alert firing severity critical lewat logger.error', () => {
    const req = createMockReq({
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'ServiceDown', severity: 'critical' },
          annotations: { summary: 'Service down' },
          startsAt: '2026-08-01T00:00:00Z',
        },
      ],
    });
    const res = createMockRes();

    handleAlertmanagerWebhook(req, res);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ alertname: 'ServiceDown', status: 'firing' }),
      expect.stringContaining('FIRING: ServiceDown')
    );
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('mencatat alert firing severity warning lewat logger.warn (BUKAN error)', () => {
    const req = createMockReq({
      status: 'firing',
      alerts: [
        {
          status: 'firing',
          labels: { alertname: 'LatencyP95AboveSLO', severity: 'warning' },
          annotations: {},
          startsAt: '2026-08-01T00:00:00Z',
        },
      ],
    });
    const res = createMockRes();

    handleAlertmanagerWebhook(req, res);

    expect(loggerWarnMock).toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('mencatat alert resolved lewat logger.info', () => {
    const req = createMockReq({
      status: 'resolved',
      alerts: [
        {
          status: 'resolved',
          labels: { alertname: 'ServiceDown', severity: 'critical' },
          annotations: {},
          startsAt: '2026-08-01T00:00:00Z',
        },
      ],
    });
    const res = createMockRes();

    handleAlertmanagerWebhook(req, res);

    expect(loggerInfoMock).toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('tidak error kalau alerts kosong/tidak ada', () => {
    const req = createMockReq({ status: 'firing' });
    const res = createMockRes();

    expect(() => handleAlertmanagerWebhook(req, res)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  describe('verifikasi ALERTMANAGER_WEBHOOK_SECRET', () => {
    const originalSecret = process.env.ALERTMANAGER_WEBHOOK_SECRET;

    afterEach(() => {
      process.env.ALERTMANAGER_WEBHOOK_SECRET = originalSecret;
      jest.resetModules();
    });

    it('menolak request dengan UnauthorizedError kalau secret dikonfigurasi tapi header tidak cocok', () => {
      process.env.ALERTMANAGER_WEBHOOK_SECRET = 'super-secret';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const controllerModule = require('./alertmanager-webhook.controller');
      const handlerWithSecret = controllerModule.handleAlertmanagerWebhook;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { UnauthorizedError } = require('../../../shared/utils/http-error');

      const req = createMockReq({ status: 'firing', alerts: [] }, { 'x-webhook-secret': 'wrong' });
      const res = createMockRes();

      expect(() => handlerWithSecret(req, res)).toThrow(UnauthorizedError);
    });

    it('menerima request kalau header cocok dengan secret yang dikonfigurasi', () => {
      process.env.ALERTMANAGER_WEBHOOK_SECRET = 'super-secret';
      jest.resetModules();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const controllerModule = require('./alertmanager-webhook.controller');
      const handlerWithSecret = controllerModule.handleAlertmanagerWebhook;

      const req = createMockReq(
        { status: 'firing', alerts: [] },
        { 'x-webhook-secret': 'super-secret' }
      );
      const res = createMockRes();

      expect(() => handlerWithSecret(req, res)).not.toThrow();
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });
});
