// Radiology overlay — operation descriptions for the contrast/allergy
// screening surface (migration 678). Legacy radiology CRUD ops predate the
// description requirement and live in the Spectral baseline; new radiology
// operations are described here so the baseline only ever shrinks.

export const schemas = {};

export const operations = {
  'PUT /api/v1/radiology/{id}/contrast': {
    summary: 'Amend the contrast plan on a radiology order awaiting acquisition',
    description:
      'Protocolling step: set or clear contrast intent (contrast_planned, contrast_agent) on an order '
      + "still in status 'ordered'. Runs the same contrast/allergy screen as order creation against the "
      + 'patient\'s unified active allergies: a contrast-relevant hit returns 409 '
      + 'RADIOLOGY_CONTRAST_ALLERGY_BLOCKED with the matched allergies unless an acknowledged override '
      + '({ override: { reason, approvedBy? } }, minimum 5-character reason) is supplied. Overrides and '
      + 'findings are persisted to medication_safety_reviews plus the canonical timeline/audit pair, and '
      + 'the screen evidence lands in radiology_orders.contrast_allergy_screen. Locked with 409 '
      + "RADIOLOGY_CONTRAST_PLAN_LOCKED once the study leaves 'ordered'.",
  },
};
