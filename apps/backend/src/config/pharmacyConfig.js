// Pharmacy order statuses — canonical UPPERCASE lifecycle matching the DB default ('PENDING')
// and the `*_at` timestamp columns on pharmacy_orders (confirmed_at, preparing_at, dispatched_at,
// delivered_at, cancelled_at).
export const ORDER_STATUS = {
  PENDING:    'PENDING',
  CONFIRMED:  'CONFIRMED',
  PREPARING:  'PREPARING',
  READY:      'READY',
  DISPATCHED: 'DISPATCHED',
  DELIVERED:  'DELIVERED',
  CANCELLED:  'CANCELLED',
};

// Allowed transitions. Terminal states (DELIVERED, CANCELLED) have empty arrays.
export const ORDER_STATUS_TRANSITIONS = {
  PENDING:    ['CONFIRMED', 'CANCELLED'],
  CONFIRMED:  ['PREPARING', 'CANCELLED'],
  PREPARING:  ['READY', 'DISPATCHED', 'CANCELLED'],
  READY:      ['DISPATCHED', 'CANCELLED'],
  DISPATCHED: ['DELIVERED', 'CANCELLED'],
  DELIVERED:  [],
  CANCELLED:  [],
};

// ── BCMA / closed-loop medication (roadmap B1) ──────────────────────────────

// Pharmacist clinical-verification axis on pharmacy_orders — orthogonal to
// ORDER_STATUS so client status enums stay untouched. PREPARING / DISPATCH /
// DISPENSE are hard-gated on verified|override (migration 278).
export const CLINICAL_VERIFICATION_STATUS = {
  PENDING: 'pending',
  VERIFIED: 'verified',
  OVERRIDE: 'override',
  REJECTED: 'rejected',
};

export const VERIFICATION_CLEARED_STATUSES = [
  CLINICAL_VERIFICATION_STATUS.VERIFIED,
  CLINICAL_VERIFICATION_STATUS.OVERRIDE,
];

// Enforcement switches (env-overridable for staged rollout; both default ON —
// they ARE the closed loop). Set the env var to 'false' to soften during a
// pilot-ward rollout only.
export const BCMA_CONFIG = {
  // Non-scan MAR administration requires an override reason (audited).
  requireScanForMarAdministration: process.env.MAR_REQUIRE_BARCODE_SCAN !== 'false',
  // Pharmacy orders require pharmacist clinical verification before
  // PREPARING / DISPATCH / counter dispense.
  requirePharmacistVerification: process.env.PHARMACY_REQUIRE_CLINICAL_VERIFICATION !== 'false',
};

// ── MAR frequency-expansion bounds (C-L3) ───────────────────────────────────

function positiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// marService.expandSchedule previously clamped any duration_days to 14
// SILENTLY — an OD × 30-day prescription scheduled only 14 days of doses and
// nobody was told. The window now covers the common real-world duration (30
// days) and anything beyond either bound is a loud 400
// (MAR_DURATION_EXCEEDS_WINDOW / MAR_SCHEDULE_DOSE_CEILING), never a silent
// truncation. maxTotalDoses is the absolute row fan-out ceiling that keeps a
// q1h × long-duration order from inserting thousands of MAR rows.
export const MAR_SCHEDULE_LIMITS = {
  maxScheduleDays: positiveIntEnv('MAR_MAX_SCHEDULE_DAYS', 30),
  maxTotalDoses: positiveIntEnv('MAR_MAX_SCHEDULE_DOSES', 360),
};

// Medication categories
export const MEDICATION_CATEGORIES = {
  ANTIBIOTICS: 'Antibiotics',
  ANALGESICS: 'Analgesics',
  CARDIOVASCULAR: 'Cardiovascular',
  DIABETES: 'Diabetes',
  RESPIRATORY: 'Respiratory',
  GASTROINTESTINAL: 'Gastrointestinal',
  VITAMINS: 'Vitamins',
  SUPPLEMENTS: 'Supplements',
  OTHER: 'Other'
};

// Stock status levels
export const STOCK_STATUS = {
  OUT_OF_STOCK: { label: 'OUT_OF_STOCK', threshold: 0 },
  LOW_STOCK: { label: 'LOW_STOCK', threshold: 10 },
  IN_STOCK: { label: 'IN_STOCK', threshold: 11 }
};

// Expiry status
export const EXPIRY_STATUS = {
  EXPIRED: 'EXPIRED',
  EXPIRING_SOON: 'EXPIRING_SOON',
  VALID: 'VALID'
};

// Default pagination
export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  DEFAULT_PAGE: 1
};
