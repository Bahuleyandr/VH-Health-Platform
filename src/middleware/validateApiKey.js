// src/middleware/validateApiKey.js
import crypto from 'crypto';
import logger from '../logging/logger.js';

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware to validate the API Key sent in request headers.
 * Blocks the request if the provided API Key does not match the expected key from environment variables.
 */
export default function validateApiKey(req, res, next) {
  const clientApiKey = req.headers['x-api-key'];
  const serverApiKey = process.env.API_KEY;

  if (!serverApiKey) {
    logger.error('❌ Server misconfiguration: API_KEY not set in environment variables.');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!clientApiKey) {
    logger.warn('❌ API Key missing in request headers');
    return res.status(401).json({ error: 'Missing API Key in request headers' });
  }

  if (!constantTimeCompare(clientApiKey, serverApiKey)) {
    logger.warn('❌ Invalid API Key provided in request headers');
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  logger.info('✅ API Key validation passed');
  next();
}
