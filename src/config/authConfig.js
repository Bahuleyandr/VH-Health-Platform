// src/config/authConfig.js - Authentication Configuration Constants

export const AUTH_CONFIG = {
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
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
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  },
  
  staff: {
    maxDevicesPerUser: parseInt(process.env.STAFF_MAX_DEVICES) || 3,
    pinLength: parseInt(process.env.STAFF_PIN_LENGTH) || 4,
    sessionDurationHours: parseInt(process.env.STAFF_SESSION_HOURS) || 12,
    requireLocationForAttendance: process.env.REQUIRE_LOCATION_ATTENDANCE === 'true',
    attendanceGeoFenceRadius: parseInt(process.env.ATTENDANCE_RADIUS_METERS) || 500
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

export const AUTH_METHODS = {
  OTP: 'otp',
  FIREBASE: 'firebase',
  PASSWORD: 'password',
  MAGIC_LINK: 'magic_link'
};