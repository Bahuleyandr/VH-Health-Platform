// src/services/insurance/clinicalJustificationTemplate.js
//
// Stage-5 fix — structured clinical-justification template for TPA
// enhancement requests.
//
// Both enhancement surfaces (the chart-side
// /api/v1/admissions/:id/tpa-enhancement and the legacy billing-side
// /api/v1/billing/insurance/claim/:id/enhancement) previously took the
// clinical justification as a single free-text string. Insurers reject
// enhancement requests with unstructured documentation, so this module
// provides a structured template + a normaliser that BOTH surfaces use.
//
// Field labels are platform-authored. Clinical content is always
// doctor-entered — the platform never pre-fills clinical narrative. The
// normaliser still accepts a legacy free-text string so existing
// callers keep working.
//
// Finding: 2026-05-09-tpa-insurance-claim-doctor-no-clinical-justification-template

import { AppError } from '../../utils/AppError.js';

export const ENHANCEMENT_JUSTIFICATION_TEMPLATE = {
  version: 1,
  title: 'TPA enhancement — clinical justification',
  description:
    'Structured clinical justification for a mid-stay TPA enhancement '
    + 'request. Field labels are platform-authored; all clinical content '
    + 'is entered by the treating doctor.',
  fields: [
    {
      key: 'clinical_reason',
      label: 'Clinical reason for enhancement',
      type: 'text',
      required: true,
      help: 'Why does this admission need additional cover? e.g. new complication, escalation of care.',
    },
    {
      key: 'complication_details',
      label: 'Complication / change in condition',
      type: 'text',
      required: false,
      help: 'Describe the complication or deterioration that drives the enhancement.',
    },
    {
      key: 'icd10_complication_code',
      label: 'ICD-10 code for complication (if applicable)',
      type: 'string',
      required: false,
      help: 'ICD-10 code for the new complication, where one applies.',
    },
    {
      key: 'treatment_plan_change',
      label: 'Change in treatment plan',
      type: 'text',
      required: false,
      help: 'What change in management or procedures does the enhancement fund?',
    },
    {
      key: 'expected_outcome',
      label: 'Expected clinical outcome',
      type: 'text',
      required: false,
      help: 'Expected outcome or goal of the extended treatment.',
    },
    {
      key: 'additional_los_days',
      label: 'Expected additional length of stay (days)',
      type: 'number',
      required: false,
      help: 'Estimated extra inpatient days the enhancement should cover.',
    },
    {
      key: 'supporting_investigations',
      label: 'Supporting investigations / findings',
      type: 'text',
      required: false,
      help: 'Summary of labs/imaging supporting the request. Attach the reports separately as documents.',
    },
  ],
};

function renderJustificationText(structured) {
  const lines = [];
  for (const field of ENHANCEMENT_JUSTIFICATION_TEMPLATE.fields) {
    if (structured[field.key] == null) continue;
    lines.push(`${field.label}: ${structured[field.key]}`);
  }
  return lines.join('\n');
}

/**
 * Normalise an enhancement justification input. Accepts either:
 *   - a legacy free-text string (kept for back-compat), or
 *   - a structured object matching ENHANCEMENT_JUSTIFICATION_TEMPLATE.
 *
 * Returns `{ format, structured, text, template_version? }` where
 * `format` is 'none' | 'free_text' | 'structured'. The `text` field is
 * always a human-readable rendering suitable for storing in the
 * existing free-text columns (insurance_preauth.notes,
 * insurance_claims.documents) so downstream consumers need no change.
 *
 * Throws AppError.badRequest on a malformed structured object or a
 * missing required field.
 */
export function normalizeClinicalJustification(input) {
  if (input == null || input === '') {
    return { format: 'none', structured: null, text: null };
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    return trimmed
      ? { format: 'free_text', structured: null, text: trimmed }
      : { format: 'none', structured: null, text: null };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw AppError.badRequest(
      'clinical_justification must be a string or an object matching the enhancement justification template',
    );
  }

  const structured = {};
  for (const field of ENHANCEMENT_JUSTIFICATION_TEMPLATE.fields) {
    let val = input[field.key];
    if (val == null || val === '') {
      if (field.required) {
        throw AppError.badRequest(
          `clinical_justification.${field.key} is required ("${field.label}")`,
        );
      }
      continue;
    }
    if (field.type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0) {
        throw AppError.badRequest(
          `clinical_justification.${field.key} must be a non-negative number`,
        );
      }
      val = n;
    } else {
      val = String(val).trim();
      if (!val) continue;
    }
    structured[field.key] = val;
  }

  if (Object.keys(structured).length === 0) {
    throw AppError.badRequest(
      'clinical_justification has no recognised fields — see GET /api/v1/insurance/enhancement-justification-template',
    );
  }

  return {
    format: 'structured',
    structured,
    text: renderJustificationText(structured),
    template_version: ENHANCEMENT_JUSTIFICATION_TEMPLATE.version,
  };
}
