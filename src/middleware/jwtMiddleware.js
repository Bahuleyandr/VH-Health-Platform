// src/middleware/jwtMiddleware.js

import { verifyToken } from '../utils/jwtUtils.js';

export default function jwtMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('JWT Middleware Denied: Missing or malformed Authorization header');
    return res.status(401).json({
      success: false,
      error: 'Authorization header missing or invalid'
    });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);

  if (!decoded) {
    console.warn('JWT Middleware Denied: Invalid or expired token');
    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
  }

  const uid = decoded.uid;
  const role = decoded.role;
  const phone = decoded.phone;

  console.log(
    `JWT Middleware Granted: User authenticated as '${role}' with UID '${uid}'`
  );

  req.user = { uid, role, phone }; // ✅ attach expected fields
  next();
}
