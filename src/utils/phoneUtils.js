// utils/phoneUtils.js

/**
 * Normalize phone number to a consistent format
 * Removes spaces, dashes, and parentheses
 * Ensures consistent country code handling
 */
export const normalizePhone = (phone) => {
  if (!phone) return null;
  
  // Remove all non-numeric characters except +
  let normalized = phone.replace(/[^\d+]/g, '');
  
  // Handle Indian phone numbers specifically
  if (normalized.length === 10 && !normalized.startsWith('+')) {
    // Assume Indian number without country code
    normalized = '+91' + normalized;
  } else if (normalized.startsWith('91') && normalized.length === 12) {
    // Indian number with country code but no +
    normalized = '+' + normalized;
  } else if (!normalized.startsWith('+') && normalized.length > 10) {
    // Assume country code is included but + is missing
    normalized = '+' + normalized;
  }
  
  return normalized;
};

/**
 * Format phone number for display
 */
export const formatPhoneDisplay = (phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) return '';
  
  // Format Indian numbers as +91 XXXXX XXXXX
  if (normalized.startsWith('+91') && normalized.length === 13) {
    return normalized.slice(0, 3) + ' ' + 
           normalized.slice(3, 8) + ' ' + 
           normalized.slice(8);
  }
  
  // Default format: +XX XXXXXXXXXX
  const countryCodeLength = normalized.indexOf(' ') > 0 ? 
    normalized.indexOf(' ') : 3;
  
  return normalized.slice(0, countryCodeLength) + ' ' + 
         normalized.slice(countryCodeLength);
};

/**
 * Validate phone number
 */
export const isValidPhone = (phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  
  // Must start with + and be between 10-15 digits total
  return /^\+\d{10,15}$/.test(normalized);
};

export default {
  normalizePhone,
  formatPhoneDisplay,
  isValidPhone
};