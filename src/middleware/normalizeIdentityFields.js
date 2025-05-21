// src/middleware/normalizeIdentityFields.js

/**
 * ✅ Normalize identity and input fields (non-mutating)
 * - Normalizes phone number to last 10 digits
 * - Ensures phoneNumber → phone
 * - Ensures consistent UID
 * - Lowercases gender and trims strings
 * - Converts empty strings to null for optional fields
 * NOTE: Only modifies req.body (not req.query or req.params)
 */

function getLast10Digits(phone) {
  if (!phone) return phone;
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-10);
}

function normalizeValue(val) {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed === '' ? null : trimmed;
  }
  return val;
}

export function normalizeIdentityFields(req, res, next) {
  const src = req.body;

  // ✅ Normalize phone fields
  const rawPhone = src?.phone || src?.phoneNumber;
  if (rawPhone) {
    req.body.phone = getLast10Digits(rawPhone);
  }

  // ✅ Normalize UID
  if (src?.uid) {
    req.body.uid = src.uid.trim();
  }

  // ✅ Normalize gender
  if (src?.gender && typeof src.gender === 'string') {
    req.body.gender = src.gender.trim().toLowerCase();
  }

  // ✅ Normalize name and email
  if (src?.name && typeof src.name === 'string') {
    req.body.name = src.name.trim();
  }

  if (src?.email && typeof src.email === 'string') {
    req.body.email = src.email.trim().toLowerCase();
  }

  // ✅ Optional fields → null if empty string
  const optionalFields = [
    'address', 'birthday', 'anniversary', 'profilePicture',
    'file_key', 'file_name', 'file_type'
  ];
  for (const field of optionalFields) {
    if (typeof src?.[field] === 'string' && src[field].trim() === '') {
      req.body[field] = null;
    }
  }

  next();
}
