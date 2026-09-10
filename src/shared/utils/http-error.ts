/**
 * Custom error class agar setiap error yang dilempar dari Service/Repository
 * layer membawa HTTP status code yang jelas, tanpa layer tersebut perlu
 * tahu apa pun soal Express (req/res).
 */
export class HttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'HttpError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, message);
    this.name = 'NotFoundError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message: string = 'Unauthorized') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * Dipakai khusus oleh RBAC (`requireRole` middleware) — beda makna
 * dari UnauthorizedError: 401 berarti "kami tidak tahu siapa Anda"
 * (token tidak ada/invalid), 403 berarti "kami tahu siapa Anda, tapi
 * Anda tidak berhak mengakses resource ini" (role tidak cukup).
 */
export class ForbiddenError extends HttpError {
  constructor(message: string = 'Anda tidak memiliki akses untuk melakukan aksi ini') {
    super(403, message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Dipakai oleh rate limiter (`express-rate-limit`) — dilempar lewat
 * `next(error)` di handler kustomnya, alih-alih membiarkan library
 * membentuk response sendiri, supaya SEMUA error (termasuk rate
 * limit) tetap melewati satu jalur format response yang sama:
 * `errorHandler`.
 */
export class TooManyRequestsError extends HttpError {
  constructor(message: string = 'Terlalu banyak permintaan, silakan coba lagi nanti') {
    super(429, message);
    this.name = 'TooManyRequestsError';
  }
}
