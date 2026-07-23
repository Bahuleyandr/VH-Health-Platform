import {
  legacyChannelsForOutboxRow,
  notificationPreferenceKeyForType,
  resolveChannelsForOutboxRow,
} from '../../utils/notifications/tenantNotificationChannels.js';

describe('tenant notification channel preferences', () => {
  it('maps appointment reminder aliases to the appointment_reminder setting key', () => {
    expect(notificationPreferenceKeyForType('appointment_reminder')).toBe('appointment_reminder');
    expect(notificationPreferenceKeyForType('appointment_reminder_24h')).toBe('appointment_reminder');
    expect(notificationPreferenceKeyForType('appointment_reminder_1h')).toBe('appointment_reminder');
  });

  it('maps result-ready aliases to the results_ready setting key', () => {
    expect(notificationPreferenceKeyForType('lab_result_ready')).toBe('results_ready');
    expect(notificationPreferenceKeyForType('investigation_result_ready')).toBe('results_ready');
    expect(notificationPreferenceKeyForType('diagnostic_result_ready')).toBe('results_ready');
    expect(notificationPreferenceKeyForType('results_ready')).toBe('results_ready');
  });

  it('proves prefs unset keeps the legacy push choice for recipient-id rows', () => {
    const row = {
      type: 'lab_result_ready',
      recipient_id: 42,
      recipient_phone: '+919000000001',
    };

    const resolved = resolveChannelsForOutboxRow(row, {});

    expect(legacyChannelsForOutboxRow(row)).toEqual(['push']);
    expect(resolved).toEqual({
      channels: ['push'],
      preferenceKey: 'results_ready',
      source: 'legacy',
    });
  });

  it('proves prefs unset keeps the legacy SMS choice for phone-only rows', () => {
    const row = {
      type: 'appointment_reminder',
      recipient_id: null,
      recipient_phone: '+919000000002',
    };

    const resolved = resolveChannelsForOutboxRow(row, {});

    expect(legacyChannelsForOutboxRow(row)).toEqual(['sms']);
    expect(resolved).toEqual({
      channels: ['sms'],
      preferenceKey: 'appointment_reminder',
      source: 'legacy',
    });
  });

  it('honors configured appointment reminder channel fan-out', () => {
    const resolved = resolveChannelsForOutboxRow(
      { type: 'appointment_reminder', recipient_id: 42, recipient_phone: '+919000000003' },
      {
        notificationChannels: {
          appointment_reminder: ['push', 'sms', 'whatsapp', 'voice'],
        },
      },
    );

    expect(resolved).toEqual({
      channels: ['push', 'sms', 'whatsapp', 'voice'],
      preferenceKey: 'appointment_reminder',
      source: 'tenant',
    });
  });

  it('normalizes, dedupes, and ignores unsupported configured channels', () => {
    const resolved = resolveChannelsForOutboxRow(
      { type: 'lab_result_ready', recipient_id: 42, recipient_phone: '+919000000004' },
      {
        notificationChannels: {
          results_ready: ['SMS', 'push', 'sms', 'fax', 'VOICE', null],
        },
      },
    );

    expect(resolved).toEqual({
      channels: ['sms', 'push', 'voice'],
      preferenceKey: 'results_ready',
      source: 'tenant',
    });
  });

  it('falls back to legacy behavior for missing, empty, or invalid configured channels', () => {
    const row = { type: 'results_ready', recipient_id: 42, recipient_phone: '+919000000005' };

    expect(resolveChannelsForOutboxRow(row, {
      notificationChannels: { results_ready: [] },
    })).toEqual({
      channels: ['push'],
      preferenceKey: 'results_ready',
      source: 'legacy',
    });
    expect(resolveChannelsForOutboxRow(row, {
      notificationChannels: { results_ready: ['fax'] },
    })).toEqual({
      channels: ['push'],
      preferenceKey: 'results_ready',
      source: 'legacy',
    });
  });

  it('leaves unrelated outbox types on their legacy path', () => {
    const row = { type: 'critical_lab_alert', recipient_id: 42, recipient_phone: '+919000000006' };

    expect(resolveChannelsForOutboxRow(row, {
      notificationChannels: { results_ready: ['whatsapp'] },
    })).toEqual({
      channels: ['push'],
      preferenceKey: null,
      source: 'legacy',
    });
  });
});
