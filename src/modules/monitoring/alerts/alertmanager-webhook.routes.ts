import { Router } from 'express';
import { handleAlertmanagerWebhook } from './alertmanager-webhook.controller';

/**
 * `handleAlertmanagerWebhook` SEPENUHNYA sinkron (tidak ada `await` di
 * dalamnya) — TIDAK dibungkus `asyncHandler` seperti Controller lain
 * di codebase ini, karena Express 4 SUDAH menangkap error yang
 * dilempar secara sinkron dari request handler biasa tanpa bantuan
 * tambahan apa pun (`asyncHandler` hanya dibutuhkan untuk menangkap
 * promise rejection dari handler ASYNC).
 */
export const alertmanagerWebhookRouter = Router();

alertmanagerWebhookRouter.post('/', handleAlertmanagerWebhook);
