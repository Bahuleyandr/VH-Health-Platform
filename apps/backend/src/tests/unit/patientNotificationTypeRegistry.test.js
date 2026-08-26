import {
  PATIENT_INBOX_NOTIFICATION_TYPES,
  PATIENT_NOTIFICATION_ACTIONS,
  PATIENT_NOTIFICATION_TYPE_CONTRACTS,
  patientNotificationContractForType,
} from '../../config/patientNotificationTypeRegistry.js';

describe('canonical patient notification type registry', () => {
  it('defines complete, local, unique policy metadata for every accepted type', () => {
    const types = PATIENT_NOTIFICATION_TYPE_CONTRACTS.map(contract => contract.type);
    expect(new Set(types).size).toBe(types.length);

    for (const contract of PATIENT_NOTIFICATION_TYPE_CONTRACTS) {
      expect(contract.type).toBe(contract.type.toLowerCase());
      expect(contract.targetUri).toMatch(/^\//);
      expect(contract.fallbackUri).toMatch(/^\//);
      expect(contract.authPolicy).toBe('current_patient_session');
      expect(contract.biometricPolicy).toBe('notification_inbox_gate');
      expect(contract.acknowledgement).toBe('mark_read');
      expect(contract.expiry).toBe('source_authoritative');
      expect(contract.owner).toEqual(expect.any(String));
      expect(patientNotificationContractForType(contract.feedType)).not.toBeNull();
    }
  });

  it('pins every newly closed workflow to a durable readable action', () => {
    expect(patientNotificationContractForType('diagnostic_result_ready')).toMatchObject({
      persistence: 'transactional_feed_and_outbox',
      targetUri: '/portal/diagnostic-results',
      deliveryReceipt: 'feed_commit_and_provider_receipt',
      inboxSupported: true,
    });
    expect(patientNotificationContractForType('referral_response_ready')).toMatchObject({
      persistence: 'transactional_feed_and_outbox',
      targetUri: '/portal/referrals',
      deliveryReceipt: 'feed_commit_and_provider_receipt',
      inboxSupported: true,
    });
    expect(patientNotificationContractForType('engagement_campaign')).toMatchObject({
      persistence: 'transactional_feed_and_outbox',
      action: PATIENT_NOTIFICATION_ACTIONS.ACKNOWLEDGE_ONLY,
      targetUri: '/notifications',
      deliveryReceipt: 'feed_commit_and_provider_receipt',
      inboxSupported: true,
    });
  });

  it('keeps transport aliases out of persisted feed types', () => {
    for (const type of ['appointment_reminder_24h', 'secure_message', 'payment_link']) {
      const contract = patientNotificationContractForType(type);
      expect(contract).toMatchObject({
        lifecycle: 'legacy_alias',
        persistence: 'transport_alias',
        inboxSupported: false,
      });
      expect(contract.feedType).not.toBe(type);
      expect(PATIENT_INBOX_NOTIFICATION_TYPES).not.toContain(type);
    }
  });

  it('requires stable positive-integer hydration for secure message threads', () => {
    expect(patientNotificationContractForType('patient_message')).toMatchObject({
      targetUri: '/portal/messages/:thread_id',
      fallbackUri: '/portal/messages',
      stableHydrationIds: ['thread_id'],
      hydrationValidators: { thread_id: 'positive_integer' },
    });
  });

  it('normalizes lookup keys without accepting unknown types', () => {
    expect(patientNotificationContractForType('  LAB_RESULT_READY  ')?.type)
      .toBe('lab_result_ready');
    expect(patientNotificationContractForType('not_registered')).toBeNull();
  });
});
