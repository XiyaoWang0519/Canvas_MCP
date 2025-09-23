export type ErrorCode =
  | 'AUTHORIZATION_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CANVAS_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'UNKNOWN';

export interface ErrorData {
  requestId?: string;
  canvasStatus?: number;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly httpStatus: number,
    public readonly data?: ErrorData
  ) {
    super(message);
    this.name = 'AppError';
  }
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'AUTHORIZATION_FAILED',
  403: 'AUTHORIZATION_FAILED',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED'
};

const STATUS_TO_MESSAGE: Record<number, string> = {
  400: 'Invalid request sent to Canvas.',
  401: 'Authorization failed: check Canvas token/scopes.',
  403: 'Authorization failed: check Canvas token/scopes.',
  404: 'Not found: course or assignment id.',
  429: 'Rate limited by Canvas; retry later.'
};

export function canvasError(
  status: number,
  requestId: string | undefined,
  fallbackMessage?: string,
  details?: unknown
): AppError {
  const code = STATUS_TO_CODE[status] ?? 'CANVAS_UNAVAILABLE';
  let httpStatus = status;

  if (status >= 500) {
    httpStatus = 503;
  }

  if (code === 'CANVAS_UNAVAILABLE') {
    httpStatus = 503;
  }

  const message =
    STATUS_TO_MESSAGE[status] ?? 'Canvas temporarily unavailable.';

  return new AppError(code, fallbackMessage ?? message, httpStatus, {
    requestId,
    canvasStatus: status,
    details
  });
}

export function unknownError(
  message: string,
  details?: unknown
): AppError {
  return new AppError('UNKNOWN', message, 500, { details });
}
