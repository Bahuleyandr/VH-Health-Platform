// src/services/security/fileScanService.js
//
// The single ingest-time application of FILE_SCAN_POLICY. Every path that
// accepts bytes from a caller and stores them calls `screenUploadBuffer` and
// stores the status it returns.
//
// The rule this enforces, in one line: NEVER ACCEPT BYTES YOU CANNOT SERVE.
// A 201 that stores a file the API will refuse forever is worse than a clean
// rejection, because the caller — a clinician attaching an investigation slip
// — believes the record is filed.
//
// See src/config/fileScanPolicy.js for the policy itself and why it exists.

import {
  FILE_SCAN_STATUS,
  acceptedScanStatusForPolicy,
  isFileScanningRequired,
  resolveFileScanPolicy,
} from '../../config/fileScanPolicy.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { SCAN_OUTCOME, scanBufferVerdict } from '../../utils/virusScanner.js';

/**
 * @typedef {Object} ScreenedUpload
 * @property {string} scanStatus one of FILE_SCAN_STATUS — persist this verbatim
 * @property {Object} metadata   audit trail of how that status was reached;
 *                               client-visible on some surfaces, so it carries
 *                               fixed operator text only, never an Error message
 */

/**
 * Screen a buffer against the deployment's declared scan policy.
 *
 * Resolves only when the file may be stored. Every refusal throws an AppError
 * so the caller cannot accidentally store an unscreened buffer by ignoring a
 * return value.
 *
 * Refusals:
 *   422 FILE_SCAN_QUARANTINED  — malware found. Refused under EVERY policy.
 *   503 FILE_SCAN_UNAVAILABLE  — scanning is `required` and no usable scanner
 *                                answered. Retryable; nothing was stored.
 *
 * @param {Buffer} buffer
 * @param {{ subject?: string, context?: Object }} [options]
 *        subject — noun used in the client-facing refusal message ("File",
 *        "Attachment"); context — extra key/values for the server-side log.
 * @returns {Promise<ScreenedUpload>}
 */
export async function screenUploadBuffer(buffer, { subject = 'File', context = {} } = {}) {
  const policy = resolveFileScanPolicy();
  const scannedAt = new Date().toISOString();

  // Declared no-scanner deployment: we do not probe, so the recorded status is
  // a statement of policy, not a failed attempt. That distinction is the whole
  // point of `not_scanned` — an operator reading the row can tell "nobody ever
  // looked, by decision" apart from "we looked and could not tell".
  if (!isFileScanningRequired()) {
    return {
      scanStatus: FILE_SCAN_STATUS.NOT_SCANNED,
      metadata: {
        scanner: 'none',
        scan_policy: policy,
        scanned_at: scannedAt,
        scan_detail: 'malware scanning is disabled by deployment configuration',
      },
    };
  }

  const verdict = await scanBufferVerdict(buffer);

  if (verdict.outcome === SCAN_OUTCOME.INFECTED) {
    logger.warn('File upload refused: malware detected', {
      ...context,
      signature: verdict.signature,
      scanPolicy: policy,
    });
    throw AppError.unprocessable(
      `${subject} was rejected by the malware scanner`,
      'FILE_SCAN_QUARANTINED',
      { scan_status: FILE_SCAN_STATUS.QUARANTINED },
    );
  }

  if (verdict.outcome !== SCAN_OUTCOME.CLEAN) {
    // `required` means required. Storing the bytes here would recreate exactly
    // the defect this module was written to remove: an accepted file that no
    // gate will ever release.
    logger.error('File upload refused: malware scanning is required but unavailable', {
      ...context,
      outcome: verdict.outcome,
      detail: verdict.detail,
      scanPolicy: policy,
    });
    throw AppError.serviceUnavailable(
      `${subject} cannot be accepted right now: the malware scanner is unavailable and this deployment requires every file to be scanned`,
      'FILE_SCAN_UNAVAILABLE',
      { scan_policy: policy },
    );
  }

  return {
    scanStatus: acceptedScanStatusForPolicy(),
    metadata: {
      scanner: 'clamav',
      scan_policy: policy,
      scanned_at: scannedAt,
    },
  };
}

export default { screenUploadBuffer };
