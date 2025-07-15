// src/middleware/corsMiddleware.js

import cors from 'cors';

/**
 * Get allowed origins based on app type and environment
 */
const getAllowedOrigins = () => {
  const origins = [];
  
  // Production origins from environment variable
  if (process.env.ALLOWED_ORIGINS) {
    origins.push(
      ...process.env.ALLOWED_ORIGINS
        .split(',')
        .map(origin => origin.trim())
        .filter(origin => origin.length > 0)
    );
  }
  
  // PATIENT APP ORIGINS (keep existing ones)
  if (process.env.PATIENT_APP_ORIGINS) {
    origins.push(
      ...process.env.PATIENT_APP_ORIGINS
        .split(',')
        .map(origin => origin.trim())
    );
  }
  
  // ADMIN APP ORIGINS
  if (process.env.ADMIN_APP_ORIGINS) {
    origins.push(
      ...process.env.ADMIN_APP_ORIGINS
        .split(',')
        .map(origin => origin.trim())
    );
  }
  
  // Development origins (only in non-production)
  if (process.env.NODE_ENV !== 'production') {
    const devOrigins = [
      'http://localhost:3000',
      'http://localhost:3001', 
      'http://localhost:3002', // Different ports for different apps
      'http://127.0.0.1:3000',
      'http://192.168.0.121:3000',
    ];
    origins.push(...devOrigins);
  }
  
  // Remove duplicates
  return [...new Set(origins)];
};

const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();
    
    // Log for debugging (remove in production)
    if (process.env.DEBUG_CORS === 'true') {
      console.log(`CORS check - Origin: ${origin}, Allowed: ${allowedOrigins.includes(origin)}`);
    }
    
    // Allow requests with no origin in development
    if (!origin) {
      if (process.env.NODE_ENV === 'production' && process.env.ALLOW_NO_ORIGIN !== 'true') {
        return callback(new Error('No origin header present'));
      }
      return callback(null, true);
    }
    
    // Check if origin is allowed
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-API-Key',
    'X-App-Type', // To identify which app is making the request
  ],
  exposedHeaders: ['X-Total-Count', 'X-Page-Count', 'X-Request-Id'],
  maxAge: 86400,
  optionsSuccessStatus: 200,
};

// Add this export for better error handling
export const corsErrorHandler = (err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    res.status(403).json({
      success: false,
      message: 'Not allowed by CORS',
      origin: req.headers.origin || 'No origin header',
      // Only in development
      ...(process.env.NODE_ENV !== 'production' && {
        allowedOrigins: getAllowedOrigins(),
        hint: 'Add this origin to ALLOWED_ORIGINS environment variable'
      })
    });
  } else {
    next(err);
  }
};

export default cors(corsOptions);