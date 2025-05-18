// src/middleware/jwtMiddleware.js
const { verifyToken } = require('../utils/jwtUtils');

module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authorization header missing or invalid' });
  }

  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);

  if (!decoded) {
    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
  }

  req.user = decoded;
  next();
};
