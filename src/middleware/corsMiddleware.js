// src/middleware/corsMiddleware.js
import cors from 'cors';
import logger from '../logging/logger.js';

/**
 * Helpers
 */
const parseCsv = (val) =>
  (val || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const unique = (arr) => [...new Set(arr)];

/**
 * Build the allowlist (exact matches) and regex matchers (pattern matches)
 */
const buildOriginMatchers = () => {
  // Exact origins you know up-front
  const defaultExact = [
    'https://api.vhhealth.app',
    'https://vh-health-backend.onrender.com',
    'https://admin.vhhealth.app',
    'https://dashboard.vhhealth.app',
  ];

  // Only allow localhost origins in development
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    defaultExact.push(
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://127.0.0.1:3000',
      'http://192.168.0.121:3000',
    );
  }

  // From environment (comma-separated)
  const exactFromEnv = [
    ...parseCsv(process.env.ALLOWED_ORIGINS),
    ...parseCsv(process.env.PATIENT_APP_ORIGINS),
    ...parseCsv(process.env.ADMIN_APP_ORIGINS),
  ];

  // Regex patterns:
  //  - Vercel preview URLs for your admin portal
  //  - Additional patterns from env (CORS_REGEXES, comma-separated)
  const regexPatterns = [
    '^https:\\/\\/vh-health-adminportal-[a-z0-9-]+\\.vercel\\.app$', // preview URLs
    ...parseCsv(process.env.CORS_REGEXES || ''),
  ];

  const regexes = regexPatterns
    .map((p) => {
      try { return new RegExp(p, 'i'); } catch { return null; }
    })
    .filter(Boolean);

  return {
    exact: new Set(unique([...defaultExact, ...exactFromEnv])),
    regexes,
  };
};

const { exact: EXACT_ALLOWLIST, regexes: REGEX_ALLOWLIST } = buildOriginMatchers();

/**
 * Per-request CORS options
 */
const corsOptionsDelegate = (req, callback) => {
  const origin = req.header('Origin');

  // Always vary cache on Origin
  req.res?.setHeader?.('Vary', 'Origin');

  // Server-to-server or non-browser request — allow but with restricted methods
  if (!origin) {
    return callback(null, {
      origin: false,
      methods: ['GET', 'HEAD', 'OPTIONS'],
      credentials: false,
    });
  }

  const isAllowed =
    EXACT_ALLOWLIST.has(origin) ||
    REGEX_ALLOWLIST.some((re) => re.test(origin));

  if (!isAllowed) {
    // Keep this log — it helped identify your issue
    logger.warn(`Blocked CORS request from origin: ${origin}`);
    const err = new Error('Not allowed by CORS');
    err.statusCode = 403;
    return callback(err);
  }

  // Allowed
  return callback(null, {
    origin: true, // echoes back the request origin when allowed
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Accept',
      'Origin',
      'X-API-Key',
      'X-App-Type',
    ],
    exposedHeaders: ['X-Total-Count', 'X-Page-Count', 'X-Request-Id'],
    maxAge: 86400,
    optionsSuccessStatus: 204,
  });
};

// Wrap to always set Vary: Origin
const applyCors = cors(corsOptionsDelegate);
const corsMiddleware = (req, res, next) => {
  res.setHeader('Vary', 'Origin');
  return applyCors(req, res, next);
};

// Dedicated CORS error handler (use after routes or right after cors in app.js)
export const corsErrorHandler = (err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(err.statusCode || 403).json({
      success: false,
      message: 'CORS: Origin not allowed',
      origin: req.headers.origin || null,
      ...(process.env.NODE_ENV !== 'production' && {
        // Helpful in dev; remove if noisy
        hint: 'Add this origin to ALLOWED_ORIGINS or CORS_REGEXES (env)',
      }),
    });
  }
  return next(err);
};

export default corsMiddleware;
