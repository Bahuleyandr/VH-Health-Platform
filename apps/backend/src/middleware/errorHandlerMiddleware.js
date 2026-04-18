// src/middleware/errorHandlerMiddleware.js

import * as Sentry from '@sentry/node';
import sourceMapSupport from 'source-map-support';
import logger from '../logging/logger.js';
import { AppError } from '../utils/AppError.js';
import { sanitizeErrorMessage } from '../utils/responseHelper.js';

/**
 * Centralized error handling middleware.
 * - Logs the error with source maps for better debugging.
 * - Reports 5xx errors to Sentry for production monitoring.
 * - Sends a formatted JSON response.
 * - Includes stack trace in the response only in development mode.
 */
export const errorHandlerMiddleware = (err, req, res, _next) => {
  // 1. Determine status code from the error object, default to 500
  const statusCode = err.statusCode || 500;

  // 2. Get the original stack trace using source maps
  const stack = sourceMapSupport.getErrorSource(err) || err.stack;

  // 3. Log the error using a structured format
  logger.error('An error occurred while processing a request', {
    error: {
      message: err.message,
      stack: stack,
    },
    request: {
      url: req.originalUrl,
      method: req.method,
      ip: req.ip,
    },
  });

  // 4. Handle AppError instances with structured response.
  // AppError messages are author-controlled, so we mark them safe but still
  // run through the sanitizer in case a service interpolated err.message.
  if (err instanceof AppError) {
    const response = {
      success: false,
      message: sanitizeErrorMessage(err.message, err.statusCode, {
        safe: true,
        context: req.originalUrl,
      }),
      code: err.code,
    };
    if (err.details) response.details = err.details;
    if (req.id) response.requestId = req.id;
    // Only report non-operational errors to Sentry
    if (!err.isOperational && statusCode >= 500) {
      Sentry.captureException(err);
    }
    return res.status(err.statusCode).json(response);
  }

  // 5. Report to Sentry, but only for server errors (5xx)
  if (statusCode >= 500) {
    Sentry.captureException(err);
  }

  // 6. Create the response body — never leak internal error details in production.
  // sanitizeErrorMessage replaces raw err.message with a generic 5xx line in
  // production and scrubs leak-pattern matches on any status.
  const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';
  const errorResponse = {
    success: false,
    message: sanitizeErrorMessage(err.message, statusCode, { context: req.originalUrl }),
    ...(req.id && { requestId: req.id }),
    // Only include the stack in development for security reasons
    ...(!isProduction && { stack }),
  };

  // 7. Send the final response
  res.status(statusCode).json(errorResponse);
};

// You can add a default export if your project convention requires it
// export default errorHandlerMiddleware;