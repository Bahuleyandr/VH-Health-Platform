import { jest } from '@jest/globals';

// Findings:
//   2026-05-09-inpatient-admission-patient-no-smartphone-no-alternative-channel
//   2026-05-09-lab-walk-in-patient-no-smartphone-no-alternative
// Rural / feature-phone patients had no non-app delivery path. The fix
// adds a `users.preferred_channel` preference plus SMS / print channels
// to the dispatcher. `resolveDeliveryChannels` is the pure mapping from
// the stored preference to the dispatcher channel list — this pins that
// contract so a feature-phone patient never silently falls back to a
// push that can't land.

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/notifications/sendEmailNotification.js', () => ({
  sendEmail: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: jest.fn() },
  default: { queue: jest.fn() },
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/sendVoiceNotification.js', () => ({
  placeVoiceCall: jest.fn(),
}));
jest.unstable_mockModule('../../utils/notifications/sendWhatsAppNotification.js', () => ({
  sendWhatsApp: jest.fn(),
}));

const { resolveDeliveryChannels } = await import(
  '../../utils/notifications/notificationDispatcher.js'
);

describe('resolveDeliveryChannels — preferred_channel → dispatcher channels', () => {
  it('routes a feature-phone patient (sms) to SMS, never a silent push', () => {
    const channels = resolveDeliveryChannels('sms');
    expect(channels).toEqual(['sms', 'inapp']);
    expect(channels).not.toContain('push');
  });

  it('routes a no-phone patient (print) to a printed handout', () => {
    const channels = resolveDeliveryChannels('print');
    expect(channels).toEqual(['print', 'inapp']);
    expect(channels).not.toContain('push');
  });

  it('keeps an opted-out patient (none) to in-app only — no outbound contact', () => {
    expect(resolveDeliveryChannels('none')).toEqual(['inapp']);
  });

  it('defaults a smartphone patient (app) to push + in-app', () => {
    expect(resolveDeliveryChannels('app')).toEqual(['push', 'inapp']);
  });

  it('falls back to the app default for null / unknown preferences', () => {
    expect(resolveDeliveryChannels(null)).toEqual(['push', 'inapp']);
    expect(resolveDeliveryChannels(undefined)).toEqual(['push', 'inapp']);
    expect(resolveDeliveryChannels('garbage')).toEqual(['push', 'inapp']);
  });

  it('is case-insensitive on the stored preference', () => {
    expect(resolveDeliveryChannels('SMS')).toEqual(['sms', 'inapp']);
    expect(resolveDeliveryChannels('Print')).toEqual(['print', 'inapp']);
  });
});
