// src/middleware/authMiddleware.js

import jwt from 'jsonwebtoken';
import logger from '../logging/logger.js';

function normalizeRole(raw) {
  const r = String(raw || '').trim().toUpperCase();
  if (r === 'SUPER_ADMIN') return 'ADMIN';
  if (r === 'NURSE') return 'NURSING_STAFF';
  return r;
}

export default function authMiddleware(req, res, next) {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];

  if (!apiKeyHeader) {
    return res.status(401).json({ success: false, error: 'API Key missing' });
  }

  if (apiKeyHeader !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API Key' });
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Authorization token missing or malformed'
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Normalize to same shape as jwtMiddleware
    const uid = decoded.uid ?? decoded.user_id ?? decoded.userId ?? decoded.id ?? decoded.sub;
    const role = normalizeRole(decoded.role ?? decoded.user_role ?? 'PATIENT');
    const phone = decoded.phone ?? decoded.phone_number ?? decoded.phoneNumber ?? null;
    const email = decoded.email ?? null;

    req.user = {
      uid: uid ? String(uid) : undefined,
      id: decoded.id ?? undefined,  // Preserve DB integer ID for IDOR checks
      role,
      phone,
      email,
    };

    next();
  } catch (err) {
    const isExpired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      error: isExpired ? 'Token has expired' : 'Invalid or expired token',
      code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
    });
  }
}
