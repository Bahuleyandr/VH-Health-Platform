// src/middleware/authMiddleware.js

module.exports = (req, res, next) => {
  const apiKeyHeader = req.headers['x-api-key'];

  if (!apiKeyHeader) {
    return res.status(401).json({ success: false, error: 'API Key missing' });
  }

  if (apiKeyHeader !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API Key' });
  }

  next();
};
