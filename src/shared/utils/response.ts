import type { Response } from 'express';

/**
 * Amplop (envelope) response sukses yang seragam di SELURUH endpoint —
 * sebelumnya tiap Controller membentuk shape-nya sendiri-sendiri
 * (`{message,data}` di sebagian besar, `{data}` polos di beberapa,
 * `{data,meta}` tanpa `message` di listing Events). Helper ini
 * satu-satunya jalan resmi mengirim response sukses, supaya tidak ada
 * lagi shape yang menyimpang.
 *
 * Response ERROR punya amplop terpisah (`{success:false, message}`),
 * dibentuk oleh `error-handler.ts` — tidak lewat helper ini, karena
 * jalurnya memang berbeda (`res.json` langsung di Controller untuk
 * sukses, vs `next(error)` → errorHandler untuk gagal).
 */
export interface SuccessResponseBody<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

export function sendSuccess<T>(
  res: Response,
  statusCode: number,
  message: string,
  data: T,
  meta?: Record<string, unknown>
): void {
  const body: SuccessResponseBody<T> = { success: true, message, data };
  if (meta) {
    body.meta = meta;
  }
  res.status(statusCode).json(body);
}
