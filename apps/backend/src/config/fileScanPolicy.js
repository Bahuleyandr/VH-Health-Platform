// src/config/fileScanPolicy.js
//
// ONE declaration of what malware scanning means for this deployment, and ONE
// vocabulary of scan outcomes. Every producer of a `scan_status` and every gate
// that reads one goes through this module.
//
// WHY THIS EXISTS
// ---------------
// Scanner availability used to be an undeclared runtime accident, and three
// consumers each carried a private, differently-shaped copy of "what counts as
// a clean file":
//   * controllers/upload/uploadController.js — allowlist {clean,cleaned,passed}
//   * services/tenant/brandKitSchema.js      — an identical private allowlist
//   * services/messaging/messagingService.js — a DENYLIST of {quarantined}
// Nothing decided what happens when no scanner is deployed, so one missing
// daemon produced two opposite defects. The generic upload path never called
// the scanner at all: it stamped 'PENDING' and no worker ever advanced it, so
// every file it accepted (201) became permanently un-servable (423) — an
// investigation slip that could never be retrieved. The messaging path did
// scan, but its denylist meant the 'failed' status an unreachable clamd always
// produces sailed straight through the download gate — unscanned bytes served
// by code that reads as though scanning protected the path.
//
// THE POLICY
// ----------
// Scanner availability is a DEPLOYMENT DECISION, declared in configuration and
// discoverable by an operator — never a per-request discovery whose meaning
// depends on which string a comparison happens to test.
//
//   FILE_SCAN_POLICY=required                 (default)
//     Every accepted file must be proven clean by the scanner AT INGEST.
//     Scanner unreachable or erroring => the upload is REJECTED and nothing is
//     stored. We never accept bytes we cannot later serve. Servable: {clean}.
//
//   FILE_SCAN_POLICY=disabled_accepted_risk
//     The deployment declares, on the record, that it operates without malware
//     scanning. No scan is attempted; files are stored 'not_scanned' — visibly
//     neither 'clean' (proven good) nor 'failed' (we tried and could not tell).
//     Servable: {clean, not_scanned}.
//
// The default is `required` because the two ways to get this wrong are not
// symmetric. A deployment that forgets to configure gets loud, immediate,
// no-data-lost 503s on upload; the opposite default would silently distribute
// never-scanned bytes. The value is spelled `disabled_accepted_risk` rather
// than `off` so that nobody sets it without reading what they are accepting.
//
// INVARIANTS — pinned by src/tests/unit/fileScanPolicy.test.js
//   * 'quarantined' is NEVER servable under ANY policy. A known-bad file stays
//     blocked forever regardless of configuration.
//   * 'pending' and 'failed' are NEVER servable under ANY policy. Both mean
//     "outcome unknown". Adding either to a servable set would make every
//     consumer serve unscanned files by default — the worst available outcome,
//     and the tempting one-line "fix" for a stuck 423. Do not do it.
//   * 'not_scanned' is servable ONLY under disabled_accepted_risk, and is only
//     ever WRITTEN under disabled_accepted_risk. It is not a synonym for
//     "clean"; it is a record that no scan happened, by policy.
//   * Under `required`, no new row can be written with any status other than
//     'clean' — infected and unscannable uploads are refused at ingest.
//     'pending' and 'failed' survive only as read-only legacy values.

/**
 * Canonical `scan_status` vocabulary. These are the values written to
 * `file_metadata.scan_status` and `staff_message_attachments.scan_status`
 * (see migration 674 for the CHECK constraint on the latter).
 */
export const FILE_SCAN_STATUS = Object.freeze({
  /** Scanner ran and found nothing. The only status that proves safety. */
  CLEAN: 'clean',
  /** Scanner ran and found malware. Never servable, never accepted at ingest. */
  QUARANTINED: 'quarantined',
  /** No scan was attempted because the deployment declared it runs without one. */
  NOT_SCANNED: 'not_scanned',
  /** Legacy only: a scan was attempted and the outcome is unknown. */
  FAILED: 'failed',
  /** Legacy only: a scan was promised and never happened. */
  PENDING: 'pending',
});

/** Permitted values of the FILE_SCAN_POLICY environment variable. */
export const FILE_SCAN_POLICY = Object.freeze({
  REQUIRED: 'required',
  DISABLED_ACCEPTED_RISK: 'disabled_accepted_risk',
});

export const FILE_SCAN_POLICY_VALUES = Object.freeze([
  FILE_SCAN_POLICY.REQUIRED,
  FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK,
]);

// Historic spellings of "clean" written by older code paths. Kept so existing
// rows keep resolving to CLEAN; nothing new is ever written with these.
const LEGACY_CLEAN_ALIASES = Object.freeze(['cleaned', 'passed']);

/**
 * Fold a raw database value into the canonical vocabulary.
 * Case-insensitive: legacy rows carry the uppercase literal 'PENDING'.
 * Anything unrecognised folds to PENDING ("outcome unknown"), which is never
 * servable — an unknown status must not become an accidental allow.
 *
 * @param {unknown} status
 * @returns {string} one of FILE_SCAN_STATUS
 */
export function normalizeScanStatus(status) {
  const raw = String(status ?? '').trim().toLowerCase();
  if (!raw) return FILE_SCAN_STATUS.PENDING;
  if (LEGACY_CLEAN_ALIASES.includes(raw)) return FILE_SCAN_STATUS.CLEAN;
  if (Object.values(FILE_SCAN_STATUS).includes(raw)) return raw;
  return FILE_SCAN_STATUS.PENDING;
}

/**
 * The deployment's declared scanning policy.
 * Unset, blank, or unrecognised resolves to `required` — fail closed.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} one of FILE_SCAN_POLICY
 */
export function resolveFileScanPolicy(env = process.env) {
  const raw = String(env.FILE_SCAN_POLICY ?? '').trim().toLowerCase();
  return raw === FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK
    ? FILE_SCAN_POLICY.DISABLED_ACCEPTED_RISK
    : FILE_SCAN_POLICY.REQUIRED;
}

/**
 * True when a file must be proven clean by the scanner before it is accepted.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isFileScanningRequired(env = process.env) {
  return resolveFileScanPolicy(env) === FILE_SCAN_POLICY.REQUIRED;
}

/**
 * The statuses a stored file may be served with under the active policy.
 * Deliberately an ALLOWLIST: a status this module has never heard of, or a
 * status meaning "unknown", can never leak through as servable.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string>}
 */
export function servableScanStatuses(env = process.env) {
  return isFileScanningRequired(env)
    ? new Set([FILE_SCAN_STATUS.CLEAN])
    : new Set([FILE_SCAN_STATUS.CLEAN, FILE_SCAN_STATUS.NOT_SCANNED]);
}

/**
 * May a stored file with this `scan_status` be handed to a caller?
 * @param {unknown} status raw database value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isScanStatusServable(status, env = process.env) {
  return servableScanStatuses(env).has(normalizeScanStatus(status));
}

/**
 * The `scan_status` a newly accepted file carries under the active policy.
 * Under `required` this is only ever reached once the scanner has returned
 * CLEAN, because every other outcome is refused at ingest.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function acceptedScanStatusForPolicy(env = process.env) {
  return isFileScanningRequired(env)
    ? FILE_SCAN_STATUS.CLEAN
    : FILE_SCAN_STATUS.NOT_SCANNED;
}

/**
 * One-line operator-facing description of the active posture. Surfaced by
 * validateEnv at boot and by the admin system-info endpoint, so "is this
 * deployment scanning?" is answerable without reading code.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function describeFileScanPolicy(env = process.env) {
  return isFileScanningRequired(env)
    ? 'required (uploads are refused when the scanner is unreachable; only clean files are served)'
    : 'disabled_accepted_risk (no scan is attempted; files are stored and served as not_scanned)';
}

export default {
  FILE_SCAN_STATUS,
  FILE_SCAN_POLICY,
  FILE_SCAN_POLICY_VALUES,
  normalizeScanStatus,
  resolveFileScanPolicy,
  isFileScanningRequired,
  servableScanStatuses,
  isScanStatusServable,
  acceptedScanStatusForPolicy,
  describeFileScanPolicy,
};
