// src/utils/virusScanner.js
//
// Transport to the local clamd daemon. This module reports WHAT HAPPENED and
// nothing else — it does not decide whether a file may be stored or served.
// That is policy, and policy lives in src/config/fileScanPolicy.js.
//
// It returns a structured verdict rather than throwing, because the previous
// throw-for-everything shape forced its only caller to guess the outcome by
// regex-matching an Error message (`/virus detected|malicious|infected/i`).
// That guess is exactly how "clamd is not deployed" ended up indistinguishable
// from "the scan completed and the file is fine, ish" at the gate.
//
// Note there is no environment knob for the endpoint: clamd is a node-local
// daemon reached over loopback. Whether the deployment HAS one is declared by
// FILE_SCAN_POLICY, not inferred from a URL being set.

import clamav from 'clamav.js';
import { PassThrough } from 'stream';

const CLAMD_HOST = '127.0.0.1';
const CLAMD_PORT = 3310;
const CLAMD_PING_TIMEOUT_MS = 1000;

/**
 * The four distinguishable things that can happen when we ask clamd about a
 * buffer. UNAVAILABLE and ERROR are deliberately separate: the first means no
 * scanner answered (the standing state of any deployment without clamd), the
 * second means one answered and then failed. Collapsing them is what made the
 * missing daemon invisible.
 */
export const SCAN_OUTCOME = Object.freeze({
  CLEAN: 'clean',
  INFECTED: 'infected',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
});

/**
 * @typedef {Object} ScanVerdict
 * @property {string}      outcome   one of SCAN_OUTCOME
 * @property {string|null} signature malware name when outcome is INFECTED
 * @property {string|null} detail    fixed, non-sensitive operator text — never
 *                                   a raw Error message, and safe to persist
 */

/**
 * Ask the local clamd daemon about a buffer. Never rejects for a scan outcome;
 * every outcome, including "no scanner", comes back as a verdict.
 *
 * @param {Buffer} buffer
 * @returns {Promise<ScanVerdict>}
 */
export function scanBufferVerdict(buffer) {
  return new Promise(resolve => {
    const readable = new PassThrough();
    readable.end(buffer);

    clamav.ping(CLAMD_PORT, CLAMD_HOST, CLAMD_PING_TIMEOUT_MS, pingErr => {
      if (pingErr) {
        return resolve({
          outcome: SCAN_OUTCOME.UNAVAILABLE,
          signature: null,
          detail: `no clamd daemon answered at ${CLAMD_HOST}:${CLAMD_PORT}`,
        });
      }

      clamav.createScanner(CLAMD_PORT, CLAMD_HOST).scan(readable, (scanErr, _object, malicious) => {
        if (scanErr) {
          return resolve({
            outcome: SCAN_OUTCOME.ERROR,
            signature: null,
            detail: 'clamd accepted the connection but did not complete the scan',
          });
        }
        if (malicious) {
          return resolve({
            outcome: SCAN_OUTCOME.INFECTED,
            signature: String(malicious),
            detail: null,
          });
        }
        resolve({ outcome: SCAN_OUTCOME.CLEAN, signature: null, detail: null });
      });
    });
  });
}

export default { SCAN_OUTCOME, scanBufferVerdict };
