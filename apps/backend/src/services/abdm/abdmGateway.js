// src/services/abdm/abdmGateway.js
// ABDM Gateway Client — handles authentication and API calls to ABDM infrastructure

import crypto from 'crypto';
import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { assertSafeOutboundUrl, safeFetch } from '../../utils/ssrfGuard.js';

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
      // Explicit environment (was hardcoded 'sbx'): ABDM_CM_ID / ABDM_ENVIRONMENT
      // drive the Consent-Manager id — see abdmConfig.cmId.
      'X-CM-ID': ABDM_CONFIG.cmId,
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
 * Send encrypted health data to the HIU (roadmap C1 follow-up).
 *
 * Per the ABDM M2 flow the encrypted entries POST directly to the HIU's
 * `dataPushUrl` from the hiRequest; the keyMaterial in the envelope is the
 * SENDER'S (our) ephemeral public material so the HIU can derive the shared
 * AES key. Falls back to the bridge ack path when no dataPushUrl was
 * captured (legacy requests recorded before migration 288).
 *
 * @param {string} transactionId - Data request transaction ID
 * @param {Array<{content: string, media: string, checksum: string, careContextReference?: string}>} entries
 *   Pre-encrypted entries (see abdmCrypto.encryptFhirBundle)
 * @param {Object} senderKeyMaterial - OUR public key material for this transfer
 * @param {Object} [options]
 * @param {string|null} [options.dataPushUrl] - HIU data-push endpoint
 */
async function sendHealthData(transactionId, entries, senderKeyMaterial, { dataPushUrl = null } = {}) {
  const body = {
    pageNumber: 1,
    pageCount: 1,
    transactionId,
    entries,
    keyMaterial: senderKeyMaterial,
  };

  if (dataPushUrl) {
    let response;
    try {
      await assertSafeOutboundUrl(dataPushUrl, {
        label: 'dataPushUrl',
        allowlistEnv: 'ABDM_DATA_PUSH_HOST_ALLOWLIST',
        allowPrivateEnv: 'ABDM_DATA_PUSH_ALLOW_PRIVATE_TARGETS',
      });
      // safeFetch (M17): pin the HIU data-push connection to the validated IPs —
      // PHI egress must not be redirectable by a DNS-rebind between check and
      // connect.
      response = await safeFetch(dataPushUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      }, {
        label: 'dataPushUrl',
        allowlistEnv: 'ABDM_DATA_PUSH_HOST_ALLOWLIST',
        allowPrivateEnv: 'ABDM_DATA_PUSH_ALLOW_PRIVATE_TARGETS',
      });
    } catch (err) {
      logger.error('ABDM data push to HIU endpoint failed (network)', {
        transactionId,
        error: err.message,
      });
      throw AppError.internal('Unable to reach HIU data-push endpoint', 'ABDM_DATA_PUSH_UNREACHABLE');
    }
    if (!response.ok) {
      const responseBody = await response.text();
      logger.error('ABDM data push to HIU endpoint rejected', {
        transactionId,
        status: response.status,
        body: responseBody.substring(0, 500),
      });
      throw AppError.internal('HIU data-push endpoint rejected the transfer', 'ABDM_DATA_PUSH_REJECTED');
    }
    logger.info('ABDM health data pushed to HIU dataPushUrl', {
      transactionId,
      entryCount: entries.length,
    });
    return;
  }

  await authenticatedRequest('POST', '/v0.5/health-information/hip/on-request', body);

  logger.info('ABDM health data sent via bridge', { transactionId, entryCount: entries.length });
}

/**
 * Notify the gateway of a completed (or failed) health-information transfer
 * — the /health-information/notify leg that follows the data push.
 * Best-effort by design; callers treat failures as non-blocking.
 */
async function notifyHealthInfoTransfer({
  transactionId,
  consentId,
  sessionStatus = 'TRANSFERRED',
  careContextReferences = [],
}) {
  const hiStatus = sessionStatus === 'TRANSFERRED' ? 'DELIVERED' : 'ERRORED';
  const body = {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    notification: {
      consentId,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: 'HIP', id: ABDM_CONFIG.hipId },
      statusNotification: {
        sessionStatus,
        hipId: ABDM_CONFIG.hipId,
        statusResponses: careContextReferences.map((ref) => ({
          careContextReference: ref,
          hiStatus,
          description: `Health information ${hiStatus.toLowerCase()}`,
        })),
      },
    },
  };

  await authenticatedRequest('POST', '/v0.5/health-information/notify', body);

  logger.info('ABDM health-information transfer notified', { transactionId, sessionStatus });
}

// ---------------------------------------------------------------------------
// ABHA enrolment (v3) — the Aadhaar-OTP / mobile-OTP flow this platform
// previously could not reach (see the registerABHA docblock: "abdmGateway
// exposes no enrolment call"). Driven against the ABHA sandbox by default
// (ABDM_CONFIG.abhaEnrolmentBaseUrl).
//
// PRIVACY CONTRACT: every sensitive value (Aadhaar number, OTP) arrives here
// ALREADY RSA-encrypted with the enrolment public certificate — this module
// never sees, logs, or persists plaintext Aadhaar/OTP material.
// ---------------------------------------------------------------------------

// Enrolment public-certificate cache (rotates rarely; refetch hourly).
let cachedEnrolmentCert = null;
let enrolmentCertExpiresAt = 0;

/**
 * Make an authenticated request against the ABHA enrolment API base.
 * Mirrors authenticatedRequest but targets abhaEnrolmentBaseUrl.
 */
async function enrolmentRequest(method, path, body = null) {
  const token = await getAccessToken();
  const url = `${ABDM_CONFIG.abhaEnrolmentBaseUrl}${path}`;
  const requestId = crypto.randomUUID();

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'REQUEST-ID': requestId,
      'TIMESTAMP': new Date().toISOString(),
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
      // Never log the request body here — it can carry encrypted Aadhaar/OTP
      // material whose presence alone should stay out of logs.
      logger.error('ABHA enrolment API request failed', {
        method,
        path,
        status: response.status,
        body: responseBody.substring(0, 500),
        requestId,
      });
      const err = AppError.internal(
        `ABHA enrolment API request failed with status ${response.status}`,
        'ABHA_ENROLMENT_API_ERROR',
      );
      err.details = { status: response.status };
      throw err;
    }
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      return await response.json();
    }
    return { status: response.status };
  } catch (err) {
    if (err.isOperational) throw err;
    logger.error('ABHA enrolment API connection error', { method, path, error: err.message });
    throw AppError.internal('Unable to connect to the ABHA enrolment API', 'ABDM_CONNECTION_ERROR');
  }
}

/**
 * Fetch (and cache) the enrolment RSA public certificate used to encrypt
 * Aadhaar numbers and OTP values in memory before they leave the process.
 * @returns {Promise<{publicKey: string}>}
 */
async function fetchEnrolmentPublicCertificate() {
  const now = Date.now();
  if (cachedEnrolmentCert && enrolmentCertExpiresAt > now) {
    return cachedEnrolmentCert;
  }
  const result = await enrolmentRequest('GET', '/profile/public/certificate');
  const publicKey = result?.publicKey || result?.certificate || null;
  if (!publicKey) {
    throw AppError.internal(
      'ABHA enrolment certificate endpoint returned no public key',
      'ABHA_ENROLMENT_CERT_MISSING',
    );
  }
  cachedEnrolmentCert = { publicKey: String(publicKey) };
  enrolmentCertExpiresAt = now + 60 * 60 * 1000;
  return cachedEnrolmentCert;
}

/**
 * Request an enrolment OTP.
 * @param {Object} params
 * @param {'abha-enrol'|'mobile-verify'} params.scope
 * @param {string} params.encryptedValue - RSA-encrypted Aadhaar number
 *   (aadhaar login hint) or mobile number (mobile-verify leg). NEVER plaintext.
 * @param {string|null} [params.txnId] - Existing ABDM txn to continue (resend /
 *   mobile-verify leg of an enrolment txn).
 * @returns {Promise<{txnId: string, message?: string}>}
 */
async function requestEnrolmentOtp({ scope, encryptedValue, txnId = null }) {
  const mobileVerify = scope === 'mobile-verify';
  const result = await enrolmentRequest('POST', '/enrollment/request/otp', {
    txnId: txnId || '',
    scope: mobileVerify ? ['abha-enrol', 'mobile-verify'] : ['abha-enrol'],
    loginHint: mobileVerify ? 'mobile' : 'aadhaar',
    loginId: encryptedValue,
    otpSystem: mobileVerify ? 'abdm' : 'aadhaar',
  });
  if (!result?.txnId) {
    throw AppError.internal(
      'ABHA enrolment OTP request returned no transaction id',
      'ABHA_ENROLMENT_NO_TXN',
    );
  }
  logger.info('ABHA enrolment OTP requested', { scope, txnId: result.txnId });
  return result;
}

/**
 * Complete Aadhaar-OTP enrolment for a transaction.
 * @param {Object} params
 * @param {string} params.txnId
 * @param {string} params.encryptedOtp - RSA-encrypted OTP. NEVER plaintext.
 * @param {string|null} [params.mobile] - Plain 10-digit communication mobile
 *   (an ABDM contact field, not Aadhaar material).
 * @returns {Promise<Object>} Gateway response ({ txnId, ABHAProfile, ... }).
 */
async function enrolByAadhaar({ txnId, encryptedOtp, mobile = null }) {
  const body = {
    authData: {
      authMethods: ['otp'],
      otp: {
        timeStamp: new Date().toISOString(),
        txnId,
        otpValue: encryptedOtp,
        ...(mobile ? { mobile } : {}),
      },
    },
    consent: { code: 'abha-enrollment', version: '1.4' },
  };
  const result = await enrolmentRequest('POST', '/enrollment/enrol/byAadhaar', body);
  logger.info('ABHA enrolment by Aadhaar-OTP completed at gateway', { txnId });
  return result;
}

/**
 * Verify the mobile-OTP (update/verify-mobile leg of an enrolment txn).
 * @param {Object} params
 * @param {string} params.txnId
 * @param {string} params.encryptedOtp - RSA-encrypted OTP. NEVER plaintext.
 * @returns {Promise<Object>}
 */
async function verifyMobileOtp({ txnId, encryptedOtp }) {
  const result = await enrolmentRequest('POST', '/enrollment/auth/byAbdm', {
    scope: ['abha-enrol', 'mobile-verify'],
    authData: {
      authMethods: ['otp'],
      otp: {
        timeStamp: new Date().toISOString(),
        txnId,
        otpValue: encryptedOtp,
      },
    },
  });
  logger.info('ABHA enrolment mobile OTP verified at gateway', { txnId });
  return result;
}

// ---------------------------------------------------------------------------
// Thin HIU legs (consent request init + health-information fetch).
// ---------------------------------------------------------------------------

/**
 * HIU: initiate a consent request at the gateway (/v0.5/consent-requests/init).
 * @returns {Promise<{requestId: string}>} echoes the requestId sent.
 */
async function initHiuConsentRequest({
  requestId,
  patientAbhaAddress,
  purposeCode,
  hiTypes,
  dateFrom,
  dateTo,
  expiryAt,
  requesterName,
}) {
  const body = {
    requestId,
    timestamp: new Date().toISOString(),
    consent: {
      purpose: { text: purposeCode, code: purposeCode },
      patient: { id: patientAbhaAddress },
      hiu: { id: ABDM_CONFIG.hiuId },
      requester: { name: requesterName || ABDM_CONFIG.hipName },
      hiTypes,
      permission: {
        accessMode: 'VIEW',
        dateRange: { from: dateFrom, to: dateTo },
        dataEraseAt: expiryAt,
        frequency: { unit: 'HOUR', value: 1, repeats: 0 },
      },
    },
  };
  await authenticatedRequest('POST', '/v0.5/consent-requests/init', body);
  logger.info('ABDM HIU consent request initiated', { requestId });
  return { requestId };
}

/**
 * HIU: request health information against a granted consent
 * (/v0.5/health-information/cm/request). keyMaterial is the PUBLIC envelope
 * from abdmCrypto.generateKeyMaterial — the private key never reaches here.
 */
async function requestHealthInformation({
  requestId,
  consentId,
  dateFrom,
  dateTo,
  dataPushUrl,
  keyMaterial,
}) {
  const body = {
    requestId,
    timestamp: new Date().toISOString(),
    hiRequest: {
      consent: { id: consentId },
      dateRange: { from: dateFrom, to: dateTo },
      dataPushUrl,
      keyMaterial,
    },
  };
  await authenticatedRequest('POST', '/v0.5/health-information/cm/request', body);
  logger.info('ABDM HIU health-information request sent', { requestId, consentId });
  return { requestId };
}

/**
 * HIU: notify the gateway of received/failed health-information transfer
 * (HIU side of /v0.5/health-information/notify). Best-effort by design.
 */
async function notifyHiuHealthInfoStatus({
  transactionId,
  consentId,
  sessionStatus = 'TRANSFERRED',
}) {
  const body = {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    notification: {
      consentId,
      transactionId,
      doneAt: new Date().toISOString(),
      notifier: { type: 'HIU', id: ABDM_CONFIG.hiuId },
      statusNotification: {
        sessionStatus,
        hipId: ABDM_CONFIG.hipId,
      },
    },
  };
  await authenticatedRequest('POST', '/v0.5/health-information/notify', body);
  logger.info('ABDM HIU health-information status notified', { transactionId, sessionStatus });
}

/**
 * Clear cached token (for testing or forced refresh).
 */
function clearTokenCache() {
  cachedToken = null;
  tokenExpiresAt = 0;
  cachedEnrolmentCert = null;
  enrolmentCertExpiresAt = 0;
}

export default {
  getAccessToken,
  authenticatedRequest,
  verifyABHA,
  notifyConsentStatus,
  sendHealthData,
  notifyHealthInfoTransfer,
  fetchEnrolmentPublicCertificate,
  requestEnrolmentOtp,
  enrolByAadhaar,
  verifyMobileOtp,
  initHiuConsentRequest,
  requestHealthInformation,
  notifyHiuHealthInfoStatus,
  clearTokenCache,
};
