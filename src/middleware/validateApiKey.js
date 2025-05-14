// src/middleware/validateApiKey.js

/**
 * Middleware to validate the API Key sent in request headers.
 * Blocks the request if the provided API Key does not match the expected key from environment variables.
 */
module.exports = function validateApiKey(req, res, next) {
  const clientApiKey = req.headers['x-api-key'];
  const serverApiKey = process.env.API_KEY;

  if (!serverApiKey) {
    console.error('Server misconfiguration: API_KEY not set in environment variables.');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!clientApiKey) {
    return res.status(401).json({ error: 'Missing API Key in request headers' });
  }

  if (clientApiKey !== serverApiKey) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  next();
};
