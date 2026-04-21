import { normalizeAuditLogUserId } from '../utils/auditLogIdentity.js';

describe('normalizeAuditLogUserId', () => {
  it('keeps numeric database ids', () => {
    expect(normalizeAuditLogUserId(42)).toBe(42);
  });

  it('parses numeric strings into integers', () => {
    expect(normalizeAuditLogUserId('42')).toBe(42);
  });

  it('returns null for UUID-only actors', () => {
    expect(normalizeAuditLogUserId('f974d551-2d5b-413f-b287-718374374739')).toBeNull();
  });

  it('returns null for missing ids', () => {
    expect(normalizeAuditLogUserId(undefined)).toBeNull();
    expect(normalizeAuditLogUserId(null)).toBeNull();
  });
});
