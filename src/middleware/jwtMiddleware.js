// src/middleware/jwtMiddleware.js
import { verifyToken } from '../utils/jwtUtils.js';

/**
 * JWT authentication middleware
 * - Accepts tokens that may use uid | user_id | userId | id | sub
 * - Normalizes role to UPPERCASE string; defaults to 'PATIENT' if absent
 * - Attaches req.user = { uid, role, phone, email, ... }
 * - 401 for missing/invalid token; 400 if UID cannot be derived
 */
export default function jwtMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || req.headers.Authorization;

  if (!authHeader || !String(authHeader).startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Missing or invalid Authorization header'
    });
  }

  const token = String(authHeader).slice(7).trim();
  const decoded = verifyToken(token); // should return payload or null/undefined

  if (!decoded) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }

  // Canonicalize UID from common claim names
  const uidRaw =
    decoded.uid ??
    decoded.user_id ??
    decoded.userId ??
    decoded.id ??
    decoded.sub;

  if (!uidRaw) {
    return res.status(400).json({ success: false, error: 'Missing or invalid UID' });
  }

  // Canonicalize role (uppercased string; default to PATIENT)
  const roleRaw =
    decoded.role ??
    decoded.user_role ??
    decoded.claims?.role ??
    'PATIENT';

  const uid = String(uidRaw);
  const role = String(roleRaw).toUpperCase();

  // Common optional fields
  const phone = decoded.phone ?? decoded.phoneNumber ?? null;
  const email = decoded.email ?? null;

  // Attach a normalized user object.
  // Also include common aliases some code paths might expect.
  req.user = {
    uid,
    id: uid,          // alias for compatibility
    userId: uid,      // alias for compatibility
    role,
    phone,
    email,
    _claims: decoded  // original claims (useful for audits/debug)
  };

  return next();
}
