// src/config/authConfig.js - Authentication Configuration Constants

import prisma from '../lib/prisma.js';
import { formatDateDDMMYYYY } from '../utils/dateUtils.js'; // Or wherever this function is
import db from './database.js'; // Or the correct path to your DB config
import { HTTP_STATUS } from './responseCodes.js'; // Or the correct path

export const AUTH_CONFIG = {
  jwt: {
    secret: process.env.JWT_SECRET,
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

export const AUTH_METHODS = {
  OTP: 'otp',
  FIREBASE: 'firebase',
  PASSWORD: 'password',
  MAGIC_LINK: 'magic_link'
};

export const verifyDevice = async (deviceToken) => {
  const result = await prisma.$queryRawUnsafe(
    `SELECT device_id, device_name, platform, last_active, staff_id, is_active
     FROM staff_devices
     WHERE device_token = $1 AND is_active = true`,
    [deviceToken]
  );
  
  if (result.rows.length === 0) {
    const error = new Error('Device not found or inactive');
    error.statusCode = HTTP_STATUS.NOT_FOUND;
    throw error;
  }
  
  const device = result[0];
  
  return {
    valid: true,
    device: {
      deviceId: device.device_id,
      deviceName: device.device_name,
      platform: device.platform,
      lastActive: formatDateDDMMYYYY(device.last_active)
    }
  };
};

export const getTodayAttendance = async (staffId) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const result = await prisma.$queryRawUnsafe(
    `SELECT id, staff_uid, check_in_time, check_out_time, duration_minutes, status, created_at FROM staff_attendance
     WHERE staff_uid = $1 AND DATE(check_in_time) = DATE($2)
     ORDER BY check_in_time DESC LIMIT 1`,
    [staffId, today]
  );
  
  if (result.rows.length === 0) {
    return {
      date: formatDateDDMMYYYY(today),
      status: 'absent',
      checkIn: null,
      checkOut: null
    };
  }
  
  const attendance = result[0];
  
  return {
    date: formatDateDDMMYYYY(today),
    status: attendance.check_out_time ? 'completed' : 'checked-in',
    checkIn: attendance.check_in_time ? formatDateDDMMYYYY(attendance.check_in_time) + ' ' + attendance.check_in_time.toTimeString().slice(0, 5) : null,
    checkOut: attendance.check_out_time ? formatDateDDMMYYYY(attendance.check_out_time) + ' ' + attendance.check_out_time.toTimeString().slice(0, 5) : null,
    duration: attendance.duration_minutes ? `${Math.floor(attendance.duration_minutes / 60)}h ${attendance.duration_minutes % 60}m` : null
  };
};

export const getAttendanceHistory = async (staffId, { startDate, endDate, page, limit }) => {
  const offset = (page - 1) * limit;
  let whereClause = 'WHERE staff_uid = $1';
  const params = [staffId];
  
  if (startDate) {
    whereClause += ` AND DATE(check_in_time) >= $${params.length + 1}`;
    params.push(startDate);
  }
  
  if (endDate) {
    whereClause += ` AND DATE(check_in_time) <= $${params.length + 1}`;
    params.push(endDate);
  }
  
  const [attendance, total] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT id, staff_uid, check_in_time, check_out_time, duration_minutes, status, created_at FROM staff_attendance
       ${whereClause}
       ORDER BY check_in_time DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM staff_attendance ${whereClause}`,
      params
    )
  ]);
  
  // Format dates
  attendance.rows.forEach(record => {
    record.date = formatDateDDMMYYYY(record.check_in_time);
    record.check_in = record.check_in_time ? formatDateDDMMYYYY(record.check_in_time) + ' ' + record.check_in_time.toTimeString().slice(0, 5) : null;
    record.check_out = record.check_out_time ? formatDateDDMMYYYY(record.check_out_time) + ' ' + record.check_out_time.toTimeString().slice(0, 5) : null;
  });
  
  return {
    attendance: attendance.rows,
    pagination: {
      page,
      limit,
      total: parseInt(total[0].count),
      totalPages: Math.ceil(total[0].count / limit)
    }
  };
};