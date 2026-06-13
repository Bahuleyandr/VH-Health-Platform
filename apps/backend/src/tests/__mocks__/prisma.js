import { jest } from '@jest/globals';

const mockPrisma = {
  users: { findUnique: jest.fn(), upsert: jest.fn(), count: jest.fn() },
  admins: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), create: jest.fn() },
  otp_sessions: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  otp_logs: { create: jest.fn(), count: jest.fn() },
  auth_logs: { create: jest.fn(), count: jest.fn() },
  password_reset_otps: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user_sessions: { count: jest.fn() },
  $transaction: jest.fn(),
};
export default mockPrisma;
