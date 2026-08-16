// Radiology overlay — operation descriptions for the contrast/allergy
// screening surface (migration 678). Legacy radiology CRUD ops predate the
// description requirement and live in the Spectral baseline; new radiology
// operations are described here so the baseline only ever shrinks.

export const schemas = {};

export const operations = {
  'POST /api/v1/radiology/orders': {
    summary: 'Create a radiology order (contrast intent derived server-side)',
    description:
      'Creates a radiology order. Contrast intent is DERIVED server-side: CT, MRI, and fluoroscopy '
      + 'orders are presumed contrast-planned — and screened against the patient\'s unified active '
      + 'allergies — unless the request explicitly negates with contrast_planned: false; plain '
      + 'radiography, ultrasound, and mammography opt in via contrast_planned: true or a named '
      + 'contrast_agent. A contrast-relevant allergy hit, or a screen that could not complete '
      + '(degraded/failed allergy lookup — the screen fails closed), returns 409 '
      + 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED with the blockers unless an acknowledged override '
      + '({ override: { reason, approvedBy? } }, minimum 5-character reason) is supplied. Screen '
      + 'evidence (status, sources consulted, findings, intent source, override) persists in '
      + 'radiology_orders.contrast_allergy_screen; findings/overrides land in '
      + 'medication_safety_reviews plus the canonical timeline/audit pair in the same transaction.',
  },
  'PUT /api/v1/radiology/{id}/contrast': {
    summary: 'Amend the contrast plan on a radiology order awaiting acquisition',
    description:
      'Protocolling step: set or clear contrast intent (contrast_planned, contrast_agent) on an order '
      + "still in status 'ordered'. Amendment intent is explicit-only: an empty body is refused (400 "
      + 'RADIOLOGY_CONTRAST_PLAN_REQUIRED) rather than read as a clear, and clearing an existing '
      + 'contrast plan requires contrast_planned: false plus a reason of at least 5 characters (400 '
      + 'RADIOLOGY_CONTRAST_CLEAR_REASON_REQUIRED otherwise). Runs the same contrast/allergy screen as '
      + 'order creation against the patient\'s unified active allergies: a contrast-relevant hit — or a '
      + 'screen that could not complete (fails closed) — returns 409 RADIOLOGY_CONTRAST_ALLERGY_BLOCKED '
      + 'with the matched allergies unless an acknowledged override ({ override: { reason, approvedBy? } }, '
      + 'minimum 5-character reason) is supplied. Overrides and findings are persisted to '
      + 'medication_safety_reviews plus the canonical timeline/audit pair. Screen evidence is append-only: '
      + 'each amendment pushes the prior contrast_allergy_screen blob (including any acknowledged '
      + 'override) into its history array — nothing is overwritten — and a clearing records who cleared '
      + 'what and why on both the evidence and the canonical timeline event. Locked with 409 '
      + "RADIOLOGY_CONTRAST_PLAN_LOCKED once the study leaves 'ordered'.",
  },
};
