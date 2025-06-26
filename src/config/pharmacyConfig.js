// Pharmacy order statuses
export const ORDER_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  READY: 'ready',
  DISPENSED: 'dispensed',
  CANCELLED: 'cancelled'
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