// src/middleware/normalizeIdentityFields.js

import { parse, isValid, format } from 'date-fns';

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

function parseFlexibleDate(input) {
  if (!input || typeof input !== 'string') return null;
  const formatsToTry = ['dd-MM-yyyy', 'yyyy-MM-dd', 'dd/MM/yyyy'];
  for (const fmt of formatsToTry) {
    const parsed = parse(input, fmt, new Date());
    if (isValid(parsed)) return format(parsed, 'yyyy-MM-dd');
  }
  return null;
}

function normalizeDates(obj, fields = []) {
  for (const field of fields) {
    if (obj?.[field]) {
      const parsed = parseFlexibleDate(obj[field]);
      if (parsed) obj[field] = parsed;
    }
  }
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

  // ✅ Normalize birthday and anniversary in body
  normalizeDates(req.body, ['birthday', 'anniversary']);

  // ✅ Normalize known date fields in query and params too
  normalizeDates(req.query, ['birthday', 'anniversary', 'fromDate', 'toDate']);
  normalizeDates(req.params, ['birthday', 'anniversary', 'fromDate', 'toDate']);

  // ✅ Optional fields → null if empty string
  const optionalFields = [
    'address',
    'birthday',
    'anniversary',
    'profilePicture',
    'file_key',
    'file_name',
    'file_type'
  ];
  for (const field of optionalFields) {
    if (typeof src?.[field] === 'string' && src[field].trim() === '') {
      req.body[field] = null;
    }
  }

  next();
}
