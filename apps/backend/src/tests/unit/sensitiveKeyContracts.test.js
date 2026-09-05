// The contract between the two redactors, and the shape of the key matcher.
//
// logMasking.js and sentryScrubber.js each carried their own copy of one
// alternation regex, with a comment on the first claiming it mirrored the
// second "so log + Sentry redaction stay consistent". Nothing enforced that.
// They had drifted: `uhid` was in the log copy and NOT the Sentry copy, so a
// key named `uhid` — a hospital patient identifier — was redacted in logs and
// sent VERBATIM to a third-party error processor.
//
// A comment asserting an invariant is not an invariant. These tests are.
import { isSensitiveKey, tokenizeKey } from '../../utils/sensitiveKeys.js';
import { scrubPhiDeep } from '../../utils/logMasking.js';
import { scrubSentryValue } from '../../utils/sentryScrubber.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UTILS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'utils');

// Keys whose VALUE must never appear in a log line or a Sentry event.
const MUST_REDACT = [
  'uhid', 'uhidNumber', 'patient_uhid',
  'mrn', 'patientMrn',
  'abha', 'abhaNumber', 'abhaAddress', 'aadhaar',
  'patient', 'patient_uid', 'patientUid', 'patient_name', 'patientName',
  'phone', 'mobile', 'email', 'address',
  'password', 'passcode', 'otp', 'pin', 'token', 'secret',
  'authorization', 'auth', 'cookie',
  'api_key', 'apiKey', 'apikey', 'hospital_id', 'hospitalId',
  'diagnosis', 'symptom', 'note', 'notes',
  'clinical', 'medical', 'record', 'records', 'record_id',
];

// Keys that carry no PHI and whose values are diagnostics worth keeping. Every
// one of these was redacted by the old substring matcher; the reason is given
// because "it looks harmless" is not a reason.
const MUST_NOT_REDACT = [
  ['expectedMappingCount', "'pin' is a substring of 'Mapping'"],
  ['observedMappingCount', "'pin' is a substring of 'Mapping'"],
  ['namespace', "'name' is a substring of 'namespace'"],
  ['recorded', "'record' is a substring of 'recorded'"],
  ['preauth_id', "'auth' is a substring of 'preauth'"],
  ['primaryKey', "'key' alone is not a term; only the pair 'api key' is"],
  ['tenantId', 'no sensitive token'],
  ['durationMs', 'no sensitive token'],
  ['shardIndex', 'no sensitive token'],
];

describe('sensitive key matcher', () => {
  it.each(MUST_REDACT)('redacts %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(MUST_NOT_REDACT)('does not redact %s (%s)', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('splits on separators, camelCase and acronym boundaries', () => {
    expect(tokenizeKey('patient_uid')).toEqual(['patient', 'uid']);
    expect(tokenizeKey('abhaNumber')).toEqual(['abha', 'number']);
    expect(tokenizeKey('HTTPStatus')).toEqual(['http', 'status']);
    expect(tokenizeKey('has-auth.token')).toEqual(['has', 'auth', 'token']);
    expect(tokenizeKey('')).toEqual([]);
    expect(tokenizeKey(null)).toEqual([]);
  });

  // The instinctive repair for the substring bug is word boundaries, and it
  // UNDER-redacts: \w includes '_', so \bpatient\b does not match
  // 'patient_uid', and camelCase has no boundary at all. Pinned so nobody
  // "simplifies" the tokeniser back into a boundary regex.
  it('still redacts the keys a word-boundary regex would let through', () => {
    for (const key of ['patient_uid', 'patientUid', 'abhaNumber', 'hospital_id']) {
      expect(/\b(patient|abha|hospital)\b/i.test(key)).toBe(false);
      expect(isSensitiveKey(key)).toBe(true);
    }
  });
});

describe('log and Sentry redaction agree', () => {
  // The regression that motivated this file: uhid was redacted in one and not
  // the other, so PHI reached a third-party processor.
  it('redacts uhid in BOTH, which was the drift', () => {
    expect(scrubPhiDeep({ uhid: 'UH-778899' }).uhid).toBe('[REDACTED]');
    expect(scrubSentryValue({ uhid: 'UH-778899' }).uhid).toBe('[Filtered]');
  });

  it.each([...MUST_REDACT, ...MUST_NOT_REDACT.map(([k]) => k)])(
    'reaches the same verdict for %s',
    (key) => {
      const logged = scrubPhiDeep({ [key]: 'VALUE-1' })[key];
      const sent = scrubSentryValue({ [key]: 'VALUE-1' })[key];
      expect(logged === '[REDACTED]').toBe(sent === '[Filtered]');
    },
  );
});

// Behavioural agreement alone would still pass if someone reintroduced a local
// copy that happened to match today. This fails the moment either module
// declares its own key vocabulary again.
describe('neither redactor carries its own key vocabulary', () => {
  it.each(['logMasking.js', 'sentryScrubber.js'])('%s imports the shared matcher', (file) => {
    const source = fs.readFileSync(path.join(UTILS, file), 'utf8');
    expect(source).toMatch(/from '\.\/sensitiveKeys\.js'/);
    // A local alternation of five or more `|`-separated bare words is what the
    // duplicated vocabulary looked like.
    const localVocabulary = /\/\((?:[a-z[\]|_ -]+\|){4,}[a-z[\]|_ -]+\)\/i/;
    expect(source).not.toMatch(localVocabulary);
  });
});
