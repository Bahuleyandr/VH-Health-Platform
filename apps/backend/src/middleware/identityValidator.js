// src/middleware/identityValidator.js
import { isPatient } from '../utils/roleHelpers.js';
import { isValidPhone, normalizePhone } from '../utils/phoneUtils.js';

// Patient endpoints establish identity from a phone or uid; staff endpoints
// do not — staff identity is the JWT role + employee id. Bypass these
// middlewares for any non-PATIENT role so the same wrapAutoRBAC defaults
// (requirePhone/requireUID = true) don't 400 staff calls that legitimately
// have no phone in the JWT or URL.
//
// Previously this used a hardcoded allowlist (`'HR'`, `'GENERAL'`,
// `'NURSE'`, …) that drifted out of sync with the canonical role
// vocabulary in `roleHelpers.js`. Roles like HR_STAFF and GENERAL_STAFF
// 400'd "Missing or invalid phone number" because the staff JWT only
// signs `{ uid, role }` (no phone claim) and the role string didn't
// match the bypass set. Inverting the predicate — bypass everything
// that isn't a PATIENT — keeps the validator in sync as new staff
// roles are added without further drift.
const isNonPatient = (role) => Boolean(role) && !isPatient(role);

export function validateUID(req, res, next) {
  const userRole = req.user?.role;
  if (isNonPatient(userRole)) {return next();}

  const explicitUid = req.body?.uid || req.query?.uid || req.params?.uid;
  const uid = explicitUid || req.user?.uid;
  if (!uid || typeof uid !== 'string' || uid.length < 6) {
    return res.status(400).json({ error: 'Missing or invalid UID' });
  }
  next();
}

export function validatePhone(req, res, next) {
  const userRole = req.user?.role;
  if (isNonPatient(userRole)) {return next();}

  const explicitPhone =
    req.body?.phone ||
    req.body?.phoneNumber ||
    req.query?.phone ||
    req.query?.phoneNumber ||
    req.params?.phone ||
    req.params?.phoneNumber;
  const phone = explicitPhone || req.user?.phone;

  // Accept either bare 10-digit local form OR full E.164 (`+91…`). The
  // patient app stores phones in E.164 (matching the OTP/Firebase flow),
  // while the staff app sometimes passes bare 10-digit. Normalising both
  // shapes through phoneUtils keeps downstream lookups consistent.
  if (!phone || !isValidPhone(phone)) {
    return res.status(400).json({ error: 'Missing or invalid phone number' });
  }
  // Mutate req.params/query so downstream handlers see the canonical form.
  const normalised = normalizePhone(phone);
  if (req.params?.phone) {req.params.phone = normalised;}
  if (req.params?.phoneNumber) {req.params.phoneNumber = normalised;}
  if (req.query?.phone) {req.query.phone = normalised;}
  if (req.query?.phoneNumber) {req.query.phoneNumber = normalised;}
  next();
}
