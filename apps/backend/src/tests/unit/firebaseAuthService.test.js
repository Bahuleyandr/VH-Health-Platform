import { jest } from '@jest/globals';

const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};

const verifyIdTokenMock = jest.fn();
const issueAccessTokenAndClaimSessionMock = jest.fn();
const ensureHospitalNumberMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/firebaseAdmin.js', () => ({
  default: {
    auth: () => ({
      verifyIdToken: verifyIdTokenMock,
    }),
  },
}));

jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits.length === 10 ? `+91${digits}` : `+${digits}`;
  },
}));

jest.unstable_mockModule('../../services/patient/patientIdentifierService.js', () => ({
  ensureHospitalNumber: ensureHospitalNumberMock,
}));

jest.unstable_mockModule('../../services/auth/loginSessionHelper.js', () => ({
  issueAccessTokenAndClaimSession: issueAccessTokenAndClaimSessionMock,
}));

const { authenticateWithFirebase } = await import(
  '../../services/auth/firebaseAuthService.js'
);

describe('firebaseAuthService.authenticateWithFirebase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    verifyIdTokenMock.mockResolvedValue({
      uid: 'firebase-uid-123',
      phone_number: '+91 98765 43210',
      email: 'patient@example.com',
      email_verified: true,
    });
    issueAccessTokenAndClaimSessionMock.mockResolvedValue({
      accessToken: 'vh-jwt-token',
    });
    ensureHospitalNumberMock.mockResolvedValue('VH-000123');
    prismaMock.$executeRawUnsafe.mockResolvedValue(undefined);
  });

  it('returns isNewUser for a new Firebase OTP patient login', async () => {
    const insertedUser = {
      id: 42,
      uid: '11111111-1111-4111-8111-111111111111',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      name: null,
      phone: '+919876543210',
      email: 'patient@example.com',
      role: 'PATIENT',
      firebase_uid: 'firebase-uid-123',
      gender: null,
      email_verified: true,
      is_active: true,
      last_login: new Date('2026-06-08T00:00:00.000Z'),
    };

    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([insertedUser]);

    const result = await authenticateWithFirebase(
      'firebase-id-token',
      null,
      {
        headers: { 'user-agent': 'jest' },
        connection: { remoteAddress: '127.0.0.1' },
      },
      { deviceType: 'mobile' },
    );

    expect(verifyIdTokenMock).toHaveBeenCalledWith('firebase-id-token');
    expect(issueAccessTokenAndClaimSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userUid: insertedUser.uid,
        deviceType: 'mobile',
        tokenPayload: expect.objectContaining({
          uid: insertedUser.uid,
          id: insertedUser.id,
          phone: insertedUser.phone,
          role: 'PATIENT',
          firebaseUid: 'firebase-uid-123',
        }),
      }),
    );
    expect(result).toMatchObject({
      accessToken: 'vh-jwt-token',
      isNewUser: true,
      user: {
        uid: insertedUser.uid,
        id: insertedUser.id,
        phone: '+919876543210',
        hospital_number: 'VH-000123',
        isNewUser: true,
        profileComplete: false,
      },
    });
  });
});
