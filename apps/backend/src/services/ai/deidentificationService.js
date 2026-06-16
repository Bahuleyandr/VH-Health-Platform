/**
 * Deterministic PHI de-identification transformer for clinical text.
 *
 * This service is a PURE, NO-LLM string transformer. It removes/redacts
 * protected health information from free-text clinical notes using two
 * complementary strategies:
 *
 *   1. Chart-anchored redaction — given a list of identifiers known to belong
 *      to a specific chart (patient name, phone, MRN, etc.), redact each by
 *      exact (case-insensitive) value. Applied LONGEST-VALUE-FIRST so a
 *      sub-string (e.g. a surname) cannot leak after its containing full name
 *      is redacted.
 *   2. Structured regex sweep — redact identifier-SHAPED tokens belonging to
 *      anyone (emails, Aadhaar numbers, phone numbers, UUIDs, MRNs, URLs)
 *      regardless of whether they were supplied as known identifiers.
 *
 * After both passes a non-destructive RESIDUAL SCAN runs over the transformed
 * text and emits flags (never rewrites) for identifier-shaped tokens that
 * survived, and for absolute dates (which v1 deliberately does NOT auto-redact,
 * to preserve clinical timeline meaning — they are flagged for human review).
 *
 * FAIL-CLOSED: any internal error suppresses the ENTIRE output (returns empty
 * text + a critical DEID_FAILED flag) rather than risk emitting un-redacted
 * PHI. Returning the original text on error is never acceptable here.
 *
 * IMPORTANT — this is a HEURISTIC transformer, not a proof of de-identification.
 * An empty residualFlags list means "no heuristic flag fired", NOT "verified
 * free of PHI". A human reviewer remains authoritative.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';

// Identifier catalog — mirrored from src/services/ai/hallucinationDefenses.js
// (this service owns its own copy by design; do NOT import them) and extended
// with Aadhaar / URL / age / date matchers for the de-id use case.
const UID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/g; // shape-only, no Verhoeff
const PHONE_RE = /\b(?:\+?\d{1,3}[-\s]?)?(?:\d{10}|\d{5}[-\s]?\d{5})\b/g;
const MRN_RE = /\bMRN[\s:-]*([A-Z0-9-]{4,20})\b/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const AGE_RE = /\b(\d{2,3})\s*(?:years?|yrs?|y\/?o|yo)\b/gi; // redact only when captured number >= 90
const DATE_RE = /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})\b/gi;

// AADHAAR is checked BEFORE PHONE so a 12-digit run isn't eaten as phones.
const STRUCTURED = [
  ['UID', UID_RE],
  ['EMAIL', EMAIL_RE],
  ['AADHAAR', AADHAAR_RE],
  ['PHONE', PHONE_RE],
  ['MRN', MRN_RE],
  ['URL', URL_RE],
];

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the replacement token for a redacted span.
 *
 * - mode 'pseudonymize' (exercised by a LATER task): a STABLE per-value token
 *   `[CATEGORY-<8 hex>]` derived from an HMAC-SHA256 over the lower-cased value,
 *   keyed by `salt`. The same value always maps to the same token within a
 *   given salt, enabling co-reference without revealing the value.
 * - any other mode: a flat `[REDACTED:CATEGORY]` token.
 */
function placeholder(category, value, mode, salt) {
  if (mode === 'pseudonymize') {
    const digest = crypto
      .createHmac('sha256', salt || '')
      .update(String(value).toLowerCase())
      .digest('hex')
      .slice(0, 8);
    return `[${category}-${digest}]`;
  }
  return `[REDACTED:${category}]`;
}

/**
 * De-identify clinical free text.
 *
 * @param {string} text - the clinical text to transform.
 * @param {object} [opts]
 * @param {Array<{value: string, category: string}>} [opts.knownIdentifiers=[]]
 *        chart-anchored identifiers to redact by exact (case-insensitive) value.
 * @param {'redact'|'pseudonymize'} [opts.mode='redact'] - replacement strategy.
 * @param {string|null} [opts.salt=null] - HMAC key for pseudonymize mode.
 * @returns {{ text: string, redactions: Array<{category: string, count: number}>,
 *            residualFlags: Array<{code: string, severity: string, message: string}> }}
 */
function deidentifyText(text, { knownIdentifiers = [], mode = 'redact', salt = null } = {}) {
  try {
    let work = String(text ?? '');
    const counts = {};
    const bump = (c) => {
      counts[c] = (counts[c] || 0) + 1;
    };
    const residualFlags = [];

    // 1. Chart-anchored known identifiers, longest value first. A throwing
    //    `value` getter raises HERE → caught below → fail-closed (intended).
    const known = [...knownIdentifiers]
      .filter((k) => k && typeof k.value === 'string' && k.value.trim())
      .sort((a, b) => b.value.length - a.value.length);

    for (const k of known) {
      // Add an alphanumeric boundary ONLY on an edge that is itself alphanumeric,
      // so a short name ("Ann") can't redact inside a larger word ("announcement")
      // — while a value with a non-word edge ("+91 98765-43210") keeps no boundary
      // there and is never under-redacted (a leak being worse than over-redaction).
      const lead = /^[A-Za-z0-9]/.test(k.value) ? '(?<![A-Za-z0-9])' : '';
      const trail = /[A-Za-z0-9]$/.test(k.value) ? '(?![A-Za-z0-9])' : '';
      work = work.replace(new RegExp(lead + escapeRegExp(k.value) + trail, 'gi'), () => {
        bump(k.category);
        return placeholder(k.category, k.value, mode, salt);
      });
    }

    // 2. Age — redact only when the captured number is >= 90 (HIPAA Safe Harbor
    //    aggregates ages 90+; younger ages are not identifiers on their own).
    work = work.replace(AGE_RE, (m, num) => {
      if (Number(num) >= 90) {
        bump('AGE');
        return placeholder('AGE', m, mode, salt);
      }
      return m;
    });

    // 3. Structured identifier sweep, in fixed order (AADHAAR before PHONE).
    for (const [cat, re] of STRUCTURED) {
      work = work.replace(re, (m) => {
        bump(cat);
        return placeholder(cat, m, mode, salt);
      });
    }

    // 4. Residual scan over the transformed text. Non-destructive — flags only.
    for (const re of [UID_RE, EMAIL_RE, AADHAAR_RE, PHONE_RE, MRN_RE]) {
      re.lastIndex = 0;
      if (re.test(work)) {
        residualFlags.push({
          code: 'RESIDUAL_PHI_SUSPECTED',
          severity: 'medium',
          message: 'identifier-shaped token(s) remain after de-identification',
        });
        break;
      }
    }
    DATE_RE.lastIndex = 0;
    if (DATE_RE.test(work)) {
      residualFlags.push({
        code: 'RESIDUAL_DATE',
        severity: 'medium',
        message: 'absolute date(s) remain (not auto-redacted in v1)',
      });
    }

    return {
      text: work,
      redactions: Object.entries(counts).map(([category, count]) => ({ category, count })),
      residualFlags,
    };
  } catch {
    // FAIL-CLOSED: suppress everything rather than risk leaking un-redacted PHI.
    return {
      text: '',
      redactions: [],
      residualFlags: [
        { code: 'DEID_FAILED', severity: 'critical', message: 'de-identification failed; text suppressed' },
      ],
    };
  }
}

/**
 * Render a birthday Date into the common free-text date forms a clinician might
 * type, so they can be redacted as chart-anchored DOB identifiers. Uses UTC
 * getters so a midnight-UTC fixture renders deterministically across host
 * timezones. Returns the DISTINCT, non-blank renderings (no category attached).
 *
 * @param {Date} d
 * @returns {string[]} e.g. ['1990-06-12', '12/06/1990', '12-06-1990', '12 Jun 1990']
 */
function dobRenderings(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return [];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const y = d.getUTCFullYear();
  const mIdx = d.getUTCMonth(); // 0-based
  const day = d.getUTCDate();
  const mm = String(mIdx + 1).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const forms = [
    `${y}-${mm}-${dd}`, // ISO yyyy-mm-dd
    `${dd}/${mm}/${y}`, // dd/mm/yyyy
    `${dd}-${mm}-${y}`, // dd-mm-yyyy
    `${day} ${MONTHS[mIdx]} ${y}`, // d Mon yyyy
  ];
  return [...new Set(forms.filter((s) => s && s.trim()))];
}

/**
 * Assemble the chart-anchored identifier list for a patient from their `users`
 * row — the exact-value redaction targets that `deidentifyText` consumes via
 * `knownIdentifiers`. Pulls the patient's own name/phone/email/address, their
 * next-of-kin (emergency_contact) name+phone, and expands their birthday into
 * common date renderings. Blank/missing fields are skipped.
 *
 * @param {string} patientUid - the patient `users.uid`.
 * @param {object} [opts]
 * @param {string} [opts.tenantId] - reserved for tenant-scoped reads.
 * @returns {Promise<Array<{value: string, category: string}>>} known identifiers,
 *          or `[]` when the patient is not found.
 */
async function collectKnownIdentifiers(patientUid, { tenantId } = {}) {
  void tenantId; // reserved for tenant-scoped reads; the row is uid-keyed today.
  const u = await prisma.users.findUnique({
    where: { uid: patientUid },
    select: {
      name: true,
      phone: true,
      email: true,
      birthday: true,
      address: true,
      emergency_contact: true,
    },
  });
  if (!u) return [];

  const out = [];
  const push = (value, category) => {
    if (value && String(value).trim()) out.push({ value: String(value).trim(), category });
  };

  push(u.name, 'NAME');
  push(u.phone, 'PHONE');
  push(u.email, 'EMAIL');
  push(u.address, 'ADDRESS');

  // Next-of-kin (emergency_contact is Json? — typically { name, phone, relationship }).
  const ec = u.emergency_contact && typeof u.emergency_contact === 'object' ? u.emergency_contact : {};
  push(ec.name, 'NAME');
  push(ec.phone, 'PHONE');

  // DOB expanded into common string renderings so it can be matched in free text.
  if (u.birthday) {
    for (const form of dobRenderings(new Date(u.birthday))) push(form, 'DOB');
  }

  return out;
}

export { deidentifyText, collectKnownIdentifiers };
export const __testing__ = { placeholder, escapeRegExp, dobRenderings };
