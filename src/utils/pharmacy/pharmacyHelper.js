// Format date to DD-MM-YYYY
export function formatDateDDMMYYYY(date) {
  if (!date) {return null;}
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

// Format datetime to DD-MM-YYYY HH:mm
export function formatDateTimeDDMMYYYY(date) {
  if (!date) {return null;}
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

// Calculate days until expiry
export function calculateDaysToExpiry(expiryDate) {
  if (!expiryDate) {return null;}
  const today = new Date();
  const expiry = new Date(expiryDate);
  const diffTime = expiry - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
}

// Determine stock status
export function getStockStatus(quantity) {
  if (quantity === 0) {return 'OUT_OF_STOCK';}
  if (quantity <= 10) {return 'LOW_STOCK';}
  return 'IN_STOCK';
}

// Determine expiry status
export function getExpiryStatus(expiryDate) {
  const daysToExpiry = calculateDaysToExpiry(expiryDate);
  if (daysToExpiry < 0) {return 'EXPIRED';}
  if (daysToExpiry <= 30) {return 'EXPIRING_SOON';}
  return 'VALID';
}