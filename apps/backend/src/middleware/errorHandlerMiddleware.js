// src/middleware/errorHandlerMiddleware.js

import * as Sentry from '@sentry/node';
import sourceMapSupport from 'source-map-support';
import logger from '../logging/logger.js';
import { AppError } from '../utils/AppError.js';
import { sanitizeErrorMessage } from '../utils/responseHelper.js';
import { generateACK } from '../services/hl7/hl7Parser.js';
import { redactSensitiveQueryParams } from '../utils/urlRedaction.js';

function sendHl7RecoveryError(res, statusCode) {
  const ackCode = statusCode >= 500 || statusCode === 409 || statusCode === 429 ? 'AE' : 'AR';
  res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
  return res.status(statusCode).send(
    generateACK('UNKNOWN', ackCode, 'HL7 receive request rejected'),
  );
}

function boundedErrorIdentifier(value) {
  const identifier = String(value || '');
  return /^[a-z0-9_.-]{1,64}$/i.test(identifier) ? identifier : null;
}

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
  const safeRequestUrl = redactSensitiveQueryParams(req.originalUrl || req.url);
  const isHl7Recovery = req.hl7InboundRecoveryRequest === true;
  const loggedError = isHl7Recovery
    ? {
        message: 'HL7 receive request processing failed',
        status_code: statusCode,
        code: boundedErrorIdentifier(err.code),
        type: boundedErrorIdentifier(err.type),
      }
    : {
        message: err.message,
        stack,
      };

  // 3. Log the error using a structured format
  logger.error('An error occurred while processing a request', {
    error: loggedError,
    request: {
      url: safeRequestUrl,
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
        context: safeRequestUrl,
      }),
      code: err.code,
    };
    if (err.details) response.details = err.details;
    if (req.id) response.requestId = req.id;
    // Only report non-operational errors to Sentry
    if (!err.isOperational && statusCode >= 500) {
      Sentry.captureException(isHl7Recovery
        ? new Error(`HL7 receive request failed with status ${statusCode}`)
        : err);
    }
    if (isHl7Recovery) {
      return sendHl7RecoveryError(res, statusCode);
    }
    return res.status(err.statusCode).json(response);
  }

  // 5. Report to Sentry, but only for server errors (5xx)
  if (statusCode >= 500) {
    Sentry.captureException(isHl7Recovery
      ? new Error(`HL7 receive request failed with status ${statusCode}`)
      : err);
  }
  if (isHl7Recovery) {
    return sendHl7RecoveryError(res, statusCode);
  }

  // 6. Create the response body — never leak internal error details in production.
  // sanitizeErrorMessage replaces raw err.message with a generic 5xx line in
  // production and scrubs leak-pattern matches on any status.
  // F-1 — stack only included when NODE_ENV=development AND opt-in via
  // EXPOSE_DEV_STACK=true. Plain non-prod (e.g. NODE_ENV=test on the
  // swarm tenant) was previously leaking dev filesystem paths in 500
  // responses. Finding:
  // 2026-05-08-emergency-walk-in-admission-beds-available-prisma-leak.
  const isDev = (process.env.NODE_ENV || '').toLowerCase() === 'development';
  const exposeStack = isDev && process.env.EXPOSE_DEV_STACK === 'true';
  const errorResponse = {
    success: false,
    message: sanitizeErrorMessage(err.message, statusCode, { context: safeRequestUrl }),
    ...(req.id && { requestId: req.id }),
    ...(exposeStack && { stack }),
  };

  // 7. Send the final response
  res.status(statusCode).json(errorResponse);
};

// You can add a default export if your project convention requires it
// export default errorHandlerMiddleware;
