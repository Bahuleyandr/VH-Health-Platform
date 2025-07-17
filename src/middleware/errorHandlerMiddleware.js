// src/middleware/errorHandlerMiddleware.js

import * as Sentry from '@sentry/node';
import sourceMapSupport from 'source-map-support';
import logger from '../logging/logger.js';

/**
 * Centralized error handling middleware.
 * - Logs the error with source maps for better debugging.
 * - Reports 5xx errors to Sentry for production monitoring.
 * - Sends a formatted JSON response.
 * - Includes stack trace in the response only in development mode.
 */
export const errorHandlerMiddleware = (err, req, res, next) => {
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

  // 4. Report to Sentry, but only for server errors (5xx)
  if (statusCode >= 500) {
    Sentry.captureException(err);
  }

  // 5. Create the response body
  const errorResponse = {
    success: false,
    message: err.message || 'An internal server error occurred.',
    // Only include the stack in development for security reasons
    ...(process.env.NODE_ENV === 'development' && { stack }),
  };

  // 6. Send the final response
  res.status(statusCode).json(errorResponse);
};

// You can add a default export if your project convention requires it
// export default errorHandlerMiddleware;