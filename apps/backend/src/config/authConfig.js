// src/config/authConfig.js - Authentication Configuration Constants

export const AUTH_CONFIG = {
  jwt: {
    secret: process.env.JWT_SECRET,
    // Audit finding L1: short access tokens (was '7d') + 30d rotating refresh.
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    algorithm: 'HS256'
  },
  
  bcrypt: {
    saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10
  },
  
  session: {
    maxConcurrentSessions: parseInt(process.env.MAX_CONCURRENT_SESSIONS) || 5,
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT_HOURS) || 24
  },
  
  rateLimit: {
    loginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5,
    windowMinutes: parseInt(process.env.LOGIN_WINDOW_MINUTES) || 15,
    blockDurationMinutes: parseInt(process.env.BLOCK_DURATION_MINUTES) || 60
  },
  
  passwordPolicy: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: true
  },
  
  firebase: {
    enabled: process.env.FIREBASE_AUTH_ENABLED === 'true',
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }
};

export const AUTH_ACTIONS = {
  LOGIN: 'login',
  LOGOUT: 'logout',
  REGISTER: 'register',
  OTP_REQUEST: 'otp_request',
  OTP_VERIFY: 'otp_verify',
  FIREBASE_LOGIN: 'firebase_login',
  FIREBASE_REGISTER: 'firebase_register',
  TOKEN_REFRESH: 'token_refresh',
  PASSWORD_RESET: 'password_reset'
};
