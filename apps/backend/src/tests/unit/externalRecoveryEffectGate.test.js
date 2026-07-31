import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  mintExternalRecoveryCapability,
  requireExternalRecoveryCapability,
} from '../../services/integrations/externalRecoveryEffectGate.js';

describe('external recovery effect capability', () => {
  it('rejects forged and scope-mismatched capabilities', () => {
    const tenantId = randomUUID();
    const capability = mintExternalRecoveryCapability({
      inboxId: randomUUID(),
      tenantId,
      facilityId: 17,
      effectDisposition: 'late_pending_only',
    });

    expect(() => requireExternalRecoveryCapability({ ...capability }))
      .toThrow('recovery-seam capability');
    expect(() => requireExternalRecoveryCapability(capability, {
      tenantId: randomUUID(),
    })).toThrow('tenant does not match');
    expect(() => requireExternalRecoveryCapability(capability, {
      facilityId: 18,
    })).toThrow('facility does not match');
    expect(() => requireExternalRecoveryCapability(capability, {
      effectDisposition: 'normal',
    })).toThrow('effect disposition does not match');
  });

  it('accepts only the exact capability minted by the recovery seam', () => {
    const tenantId = randomUUID();
    const capability = mintExternalRecoveryCapability({
      inboxId: randomUUID(),
      tenantId,
      facilityId: 17,
      effectDisposition: 'late_pending_only',
    });
    expect(requireExternalRecoveryCapability(capability, {
      tenantId,
      facilityId: 17,
      effectDisposition: 'late_pending_only',
    })).toBe(capability);
  });

  it('keeps provider and notification delivery imports outside the recovery adapter', () => {
    const recoveryService = readFileSync(
      new URL(
        '../../services/integrations/externalInterfaceRecoveryService.js',
        import.meta.url,
      ),
      'utf8',
    );
    expect(recoveryService).not.toMatch(/notificationOutbox|realtimeEmitter|firebase|twilio/i);
    expect(recoveryService).not.toMatch(/sendNotification|sendSms|sendEmail|emitColdChainEvent/);
  });
});
