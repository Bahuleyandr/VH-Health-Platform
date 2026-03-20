// src/middleware/authMiddleware.js

import jwt from 'jsonwebtoken';

export default function authMiddleware(req, res, next) {
  const apiKeyHeader = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];

  // NOTE: test auth bypass removed — use proper JWT tokens in tests
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
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}
