export class BackendError extends Error {
  constructor(
    message: string,
    public readonly backend: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export class BackendBusyError extends BackendError {
  constructor(backend: string, public readonly retryAfterSec: number) {
    super(`Backend "${backend}" busy — queue full`, backend);
    this.name = 'BackendBusyError';
  }
}

export class BackendQuotaError extends BackendError {
  constructor(backend: string, message: string) {
    super(message, backend);
    this.name = 'BackendQuotaError';
  }
}

export class BackendRevokedError extends BackendError {
  constructor(backend: string, message = 'Refresh token revoked') {
    super(message, backend);
    this.name = 'BackendRevokedError';
  }
}

export class BackendTimeoutError extends BackendError {
  constructor(backend: string, ms: number) {
    super(`Backend "${backend}" timed out after ${ms}ms`, backend);
    this.name = 'BackendTimeoutError';
  }
}

export class BackendCancelledError extends BackendError {
  constructor(backend: string) {
    super(`Backend "${backend}" call cancelled`, backend);
    this.name = 'BackendCancelledError';
  }
}

/**
 * Client-safe error message for 500 responses. Proxy-generated errors
 * (timeout, cancel, busy, quota) have intentional messages and pass through;
 * anything else may contain CLI stderr or file paths and is replaced with a
 * generic message — full detail stays in server logs.
 */
export function publicErrorMessage(err: unknown): string {
  if (
    err instanceof BackendBusyError ||
    err instanceof BackendTimeoutError ||
    err instanceof BackendCancelledError ||
    err instanceof BackendQuotaError
  ) {
    return err.message;
  }
  return 'Upstream backend error';
}
