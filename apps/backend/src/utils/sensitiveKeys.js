// Sensitive object-KEY vocabulary, shared by every redactor.
//
// WHY THIS MODULE EXISTS. logMasking.js and sentryScrubber.js each carried
// their own copy of this list, with a comment on the first saying it "mirrors"
// the second "so log + Sentry redaction stay consistent". Nothing enforced
// that, and they had drifted: `uhid` was in the log list and NOT in the Sentry
// one, so a key named `uhid` — a hospital patient identifier — was redacted in
// logs and sent VERBATIM to a third-party error processor. A stated invariant
// with no enforcement is not an invariant. One list, one matcher, and a test
// that fails if either module stops using them.
//
// WHY TOKENS AND NOT A SUBSTRING REGEX. The previous pattern was a bare
// alternation tested against the whole key, so any key CONTAINING a term
// anywhere matched. That is wrong in both directions:
//
//   * `expectedMappingCount` was redacted because 'pin' is inside 'Mapping'.
//     `namespace` went because of 'name'; `recorded` because of 'record';
//     `preauth_id` because of 'auth'. All are counts, flags or ids carrying no
//     PHI, and a redacted count still looks like an ordinary log line — so the
//     diagnostic was destroyed silently.
//   * The obvious repair — word boundaries — UNDER-redacts real PHI, which is
//     far worse. `\w` includes `_`, so `\bpatient\b` does NOT match
//     `patient_uid`, and camelCase has no boundary at all: `patientUid` and
//     `abhaNumber` would both start passing. Measured before writing this.
//
// So: split the key into tokens on `_`, `-`, `.`, whitespace and camelCase
// transitions, then match whole tokens. `patient_uid` -> [patient, uid] and
// still redacts. `expectedMappingCount` -> [expected, mapping, count] and no
// token is 'pin'.
//
// SCOPE OF THE CHANGE. This fixes the ACCIDENTAL-substring class only. Keys
// where a listed term genuinely appears as a token — `ward_name`,
// `patientScoped`, `has_auth_token` — still redact. That is conservative and
// deliberate: deciding case-by-case that a particular `*_name` carries no PHI
// is exactly where under-redaction would creep in.

// Terms matched against a single token.
const SENSITIVE_TOKENS = new Set([
  'password', 'passcode', 'pin', 'otp', 'token', 'secret',
  'authorization', 'auth', 'cookie',
  'phone', 'mobile', 'email', 'name', 'address',
  'patient', 'diagnosis', 'symptom', 'note',
  'clinical', 'medical', 'record',
  'abha', 'aadhaar', 'mrn', 'uhid',
  // Concatenated forms of the two-word terms below. The old regex wrote these
  // as `api[-_ ]?key` and `hospital[-_ ]?id`, so it matched `apikey` and
  // `hospitalid` with no separator at all — a form the tokeniser cannot split
  // and the adjacent-pair rule therefore never sees. Caught by the
  // must-redact table, which is what that table is for.
  'apikey', 'hospitalid',
]);

// Terms that are two tokens once split, matched against ADJACENT pairs.
// 'api_key', 'apiKey' and 'api key' all tokenise to [api, key]; 'hospital_id'
// and 'hospitalId' to [hospital, id]. Matching the pair rather than adding
// 'key' or 'id' as single tokens is what keeps `primaryKey` and `record_id`'s
// `id` from dragging in every identifier in the codebase.
const SENSITIVE_TOKEN_PAIRS = new Set([
  'api key',
  'hospital id',
]);

/**
 * Split an object key into lowercase word tokens.
 * `patient_uid` -> ['patient','uid']; `abhaNumber` -> ['abha','number'];
 * `HTTPStatus` -> ['http','status'].
 */
export function tokenizeKey(key) {
  if (typeof key !== 'string' || key.length === 0) return [];
  return key
    // camelCase and acronym boundaries, before lowercasing loses them
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/**
 * True when an object key names something whose VALUE must be redacted
 * wholesale, regardless of the value's shape.
 */
export function isSensitiveKey(key) {
  const tokens = tokenizeKey(key);
  if (tokens.length === 0) return false;
  for (const token of tokens) {
    if (SENSITIVE_TOKENS.has(token)) return true;
    // Treat a plural as its singular so `records` and `record` cannot
    // disagree. Checked AFTER the direct hit so 'address' is never clipped
    // to 'addres'.
    if (token.length > 3 && token.endsWith('s')
        && SENSITIVE_TOKENS.has(token.slice(0, -1))) return true;
  }
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (SENSITIVE_TOKEN_PAIRS.has(`${tokens[i]} ${tokens[i + 1]}`)) return true;
  }
  return false;
}

export const SENSITIVE_KEY_TOKENS = SENSITIVE_TOKENS;
export const SENSITIVE_KEY_TOKEN_PAIRS = SENSITIVE_TOKEN_PAIRS;
