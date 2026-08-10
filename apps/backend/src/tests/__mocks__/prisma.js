import { jest } from '@jest/globals';

// users.phone/firebase_uid are unique per-tenant now (mig 333), so code reads
// via findFirst where it previously used findUnique. Tests mock either name;
// aliasing both to one fn means a `users.findUnique.mockResolvedValue(...)`
// setup also drives findFirst, and a call is recorded once either way.
const usersFind = jest.fn();
const mockPrisma = {
  users: { findFirst: usersFind, findUnique: usersFind, upsert: jest.fn(), update: jest.fn(), create: jest.fn(), count: jest.fn() },
  admins: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), create: jest.fn() },
  otp_sessions: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  otp_logs: { create: jest.fn(), count: jest.fn() },
  auth_logs: { create: jest.fn(), count: jest.fn() },
  password_reset_otps: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  user_sessions: { count: jest.fn() },
  $transaction: jest.fn(),
  // Raw escape hatches used by shared auth plumbing (token-epoch reads,
  // totp_challenges insert, active-session upserts). Default to "no rows" /
  // "1 row affected" so service flows that merely pass through them keep
  // working; tests that care about a specific raw call re-mock these.
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  $executeRawUnsafe: jest.fn().mockResolvedValue(1),
};
export default mockPrisma;
