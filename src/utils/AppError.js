/**
 * Custom application error with HTTP status code and machine-readable error code.
 * All services should throw AppError instead of generic Error.
 * The global error handler formats it into the standard response envelope.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // Distinguishes expected errors from programming bugs
  }

  static badRequest(message, code = 'BAD_REQUEST', details = null) {
    return new AppError(message, 400, code, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new AppError(message, 401, code);
  }

  static forbidden(message = 'Insufficient permissions', code = 'FORBIDDEN') {
    return new AppError(message, 403, code);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new AppError(message, 404, code);
  }

  static conflict(message, code = 'CONFLICT', details = null) {
    return new AppError(message, 409, code, details);
  }

  static tooMany(message = 'Too many requests', code = 'RATE_LIMITED') {
    return new AppError(message, 429, code);
  }

  static internal(message = 'Internal server error', code = 'INTERNAL_ERROR') {
    return new AppError(message, 500, code);
  }

  static invalidTransition(from, to, allowed) {
    return new AppError(
      `Invalid state transition from ${from} to ${to}`,
      400,
      'INVALID_STATE_TRANSITION',
      { from, to, allowed }
    );
  }

  // Security-specific factory methods
  static accountLocked(message = 'Account temporarily locked due to too many failed attempts') {
    return new AppError(message, 423, 'ACCOUNT_LOCKED');
  }

  static tokenExpired(message = 'Token has expired') {
    return new AppError(message, 401, 'TOKEN_EXPIRED');
  }

  static tokenRevoked(message = 'Token has been revoked') {
    return new AppError(message, 401, 'TOKEN_REVOKED');
  }

  static tokenInvalid(message = 'Invalid or expired token') {
    return new AppError(message, 401, 'TOKEN_INVALID');
  }

  static invalidCredentials(message = 'Invalid credentials') {
    return new AppError(message, 401, 'INVALID_CREDENTIALS');
  }

  static accountDeactivated(message = 'Account is deactivated') {
    return new AppError(message, 403, 'ACCOUNT_DEACTIVATED');
  }
}

export default AppError;
