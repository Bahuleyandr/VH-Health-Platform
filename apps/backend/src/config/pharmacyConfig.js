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
