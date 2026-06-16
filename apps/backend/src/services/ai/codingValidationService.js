/**
 * codingValidationService.js
 *
 * Annotates a clinical_coding_assist draft by validating each suggested
 * ICD-10 code against the terminology master (via terminologyService.validateCode).
 *
 * Design: fail-closed — a lookup error treats the code as unvalidated rather
 * than surfacing an exception to the caller.  Unvalidated codes are KEPT in
 * the output (not dropped) so a human coder can review them; they are flagged
 * with validated:false, confidence:'low', and an UNVALIDATED_CODE safety flag.
 *
 * validateCode() return shape (terminologyService.js:293):
 *   always returns an object — never null:
 *   { valid: boolean, mode: 'catalog'|'structural'|'unimported', reason: string|null, concept: row|null }
 *   concept row (when present): { code, display, category, semantic_tag, status, properties }
 */

import * as terminologyService from '../terminology/terminologyService.js';

/**
 * Checks whether a validateCode() result represents a genuinely valid,
 * active concept.  The real return always carries `valid: boolean`, so
 * this is the single source of truth for "the code is trusted".
 *
 * @param {object|null} result - return value of terminologyService.validateCode()
 * @returns {boolean}
 */
function isValidResult(result) {
  if (!result) return false;
  return result.valid === true;
}

/**
 * Annotate a coding-assist draft.
 *
 * @param {object} draft - the raw output of codingAssist() from clinicalAiWorkflowService
 *   Expected shape: { suggested_codes: Array<{ code, description?, confidence? }>, ... }
 * @param {object} [context]
 * @param {string|null} [context.tenantId]
 * @returns {Promise<{ suggested_codes: Array<object>, safety_flags: Array<object> }>}
 */
export async function annotateCodingDraft(draft, { tenantId = null } = {}) {
  const input = Array.isArray(draft?.suggested_codes) ? draft.suggested_codes : [];
  const annotated = [];
  let unvalidated = 0;

  for (const item of input) {
    const code = String(item?.code || '').trim();
    let validated = false;
    let display = item?.display || item?.description || null;

    if (code && code.toUpperCase() !== 'UNSPECIFIED') {
      try {
        const result = await terminologyService.validateCode('ICD10', code);
        validated = isValidResult(result);
        if (validated && result.concept?.display) {
          display = result.concept.display;
        }
      } catch {
        validated = false;
      }
    }

    if (!validated) unvalidated += 1;

    annotated.push({
      system: 'ICD10',
      code: code || null,
      display,
      validated,
      confidence: validated ? (item?.confidence || 'medium') : 'low',
    });
  }

  const safety_flags =
    unvalidated > 0
      ? [
          {
            type: 'UNVALIDATED_CODE',
            severity: 'medium',
            detail: `${unvalidated} suggested ICD-10 code(s) not found in the terminology master`,
          },
        ]
      : [];

  return { suggested_codes: annotated, safety_flags };
}

export default { annotateCodingDraft };
