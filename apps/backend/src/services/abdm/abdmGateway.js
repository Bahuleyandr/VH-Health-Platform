// src/services/abdm/abdmGateway.js
// ABDM Gateway Client — handles authentication and API calls to ABDM infrastructure

import crypto from 'crypto';
import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';

// Token cache
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get an access token from the ABDM gateway.
 * Caches the token and auto-refreshes when expired.
 * @returns {Promise<string>} Bearer token
 */
async function getAccessToken() {
  if (!ABDM_CONFIG.enabled) {
    throw AppError.badRequest('ABDM integration is not enabled', 'ABDM_DISABLED');
  }

  if (!ABDM_CONFIG.clientId || !ABDM_CONFIG.clientSecret) {
    throw AppError.badRequest('ABDM credentials are not configured', 'ABDM_NOT_CONFIGURED');
  }

  // Return cached token if still valid (with 60s buffer)
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  try {
    const response = await fetch(`${ABDM_CONFIG.gatewayUrl}/v0.5/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: ABDM_CONFIG.clientId,
        clientSecret: ABDM_CONFIG.clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text();
      logger.error('ABDM session token request failed', {
        status: response.status,
        body: body.substring(0, 500),
      });
      throw AppError.internal('Failed to obtain ABDM access token', 'ABDM_AUTH_FAILED');
    }

    const data = await response.json();
    cachedToken = data.accessToken;
    // ABDM tokens typically expire in 1800s (30min); use expiresIn if provided
    const expiresInMs = (data.expiresIn || 1800) * 1000;
    tokenExpiresAt = now + expiresInMs;

    logger.info('ABDM access token obtained successfully');
    return cachedToken;
  } catch (err) {
    if (err.isOperational) throw err;
    logger.error('ABDM gateway connection error', { error: err.message });
    throw AppError.internal('Unable to connect to ABDM gateway', 'ABDM_CONNECTION_ERROR');
  }
}

/**
 * Make an authenticated request to the ABDM gateway/bridge.
 * @param {string} method - HTTP method
 * @param {string} path - API path (appended to bridgeUrl)
 * @param {Object|null} body - Request body
 * @returns {Promise<Object>} Parsed response
 */
async function authenticatedRequest(method, path, body = null) {
  const token = await getAccessToken();

  const url = `${ABDM_CONFIG.bridgeUrl}${path}`;
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-CM-ID': 'sbx', // sandbox; override for production
      'REQUEST-ID': requestId,
      'TIMESTAMP': timestamp,
    },
    signal: AbortSignal.timeout(30000),
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error('ABDM API request failed', {
        method,
        path,
        status: response.status,
        body: responseBody.substring(0, 500),
        requestId,
      });
      throw AppError.internal(
        `ABDM API request failed with status ${response.status}`,
        'ABDM_API_ERROR'
      );
    }

    // Some ABDM endpoints return 202 with no body
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }
    return { status: response.status };
  } catch (err) {
    if (err.isOperational) throw err;
    logger.error('ABDM API connection error', { method, path, error: err.message });
    throw AppError.internal('Unable to connect to ABDM API', 'ABDM_CONNECTION_ERROR');
  }
}

/**
 * Verify an ABHA number via ABDM gateway.
 * @param {string} abhaNumber - 14-digit ABHA number
 * @returns {Promise<Object>} Verification result with patient details
 */
async function verifyABHA(abhaNumber) {
  if (!abhaNumber || !/^\d{14}$/.test(abhaNumber.replace(/-/g, ''))) {
    throw AppError.badRequest('Invalid ABHA number format. Must be 14 digits.', 'INVALID_ABHA');
  }

  const result = await authenticatedRequest('POST', '/v1/patients/find', {
    id: abhaNumber,
    purpose: 'KYC_AND_LINK',
    requester: {
      type: 'HIP',
      id: ABDM_CONFIG.hipId,
    },
  });

  return result;
}

/**
 * Notify the ABDM gateway of a consent status change.
 * @param {string} consentId - Consent request ID
 * @param {string} status - New status (GRANTED, DENIED, REVOKED)
 * @param {Object|null} consentArtifact - Consent artifact (for GRANTED)
 */
async function notifyConsentStatus(consentId, status, consentArtifact = null) {
  const body = {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    notification: {
      consentRequestId: consentId,
      status,
    },
  };

  if (status === 'GRANTED' && consentArtifact) {
    body.notification.consentArtefacts = [consentArtifact];
  }

  await authenticatedRequest('POST', '/v0.5/consents/hip/on-notify', body);

  logger.info('ABDM consent status notification sent', { consentId, status });
}

/**
 * Send encrypted health data to the HIU via ABDM gateway.
 * @param {string} transactionId - Data request transaction ID
 * @param {Object} encryptedData - Encrypted FHIR bundle
 * @param {Object} keyMaterial - Key material for encryption
 */
async function sendHealthData(transactionId, encryptedData, keyMaterial) {
  const body = {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    transactionId,
    entries: [
      {
        content: JSON.stringify(encryptedData),
        media: 'application/fhir+json',
        checksum: crypto.createHash('md5').update(JSON.stringify(encryptedData)).digest('hex'),
      },
    ],
    keyMaterial,
  };

  await authenticatedRequest('POST', '/v0.5/health-information/hip/on-request', body);

  logger.info('ABDM health data sent successfully', { transactionId });
}

/**
 * Clear cached token (for testing or forced refresh).
 */
function clearTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
}

export default {
  getAccessToken,
  authenticatedRequest,
  verifyABHA,
  notifyConsentStatus,
  sendHealthData,
  clearTokenCache,
};
