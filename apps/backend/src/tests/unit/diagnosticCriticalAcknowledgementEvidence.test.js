import { hasValidDiagnosticCriticalAcknowledgementReceipt } from '../../services/diagnostics/diagnosticCriticalAcknowledgementEvidence.js';

const assigneeUid = '11111111-1111-4111-8111-111111111111';
const adminUid = '22222222-2222-4222-8222-222222222222';

function receipt(overrides = {}) {
  return {
    taskStatus: 'in_progress',
    slaCompletedAt: new Date('2026-07-22T10:00:00.000Z'),
    assignedToUid: assigneeUid,
    assignedToRole: null,
    taskMetadata: {
      acknowledged_at: '2026-07-22T10:00:00.000Z',
      acknowledged_by: assigneeUid,
      acknowledged_via: 'assignee',
    },
    ...overrides,
  };
}

describe('diagnostic critical acknowledgement evidence', () => {
  it('accepts a durable receipt from the exact named assignee', () => {
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt())).toBe(true);
  });

  it('rejects an assignee receipt recorded for a different actor', () => {
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      taskMetadata: {
        acknowledged_at: '2026-07-22T10:00:00.000Z',
        acknowledged_by: adminUid,
        acknowledged_via: 'assignee',
      },
    }))).toBe(false);
  });

  it('rejects role acknowledgement when the task has no role assignment', () => {
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      taskMetadata: {
        acknowledged_at: '2026-07-22T10:00:00.000Z',
        acknowledged_by: adminUid,
        acknowledged_via: 'role',
      },
    }))).toBe(false);
  });

  it('accepts a task-administrator receipt', () => {
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      taskMetadata: {
        acknowledged_at: '2026-07-22T10:00:00.000Z',
        acknowledged_by: adminUid,
        acknowledged_via: 'admin',
      },
    }))).toBe(true);
  });

  it('requires complete durable override provenance', () => {
    const metadata = {
      acknowledged_at: '2026-07-22T10:00:00.000Z',
      acknowledged_by: adminUid,
      acknowledged_via: 'override',
    };
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      taskMetadata: metadata,
    }))).toBe(false);
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      taskMetadata: {
        ...metadata,
        acknowledge_override_source: 'patient_access_break_glass',
        acknowledge_override_id: '17',
        acknowledge_override_reason: 'Emergency cross-cover acknowledgement',
      },
    }))).toBe(true);
  });

  it('rejects malformed timestamps and an unstopped SLA', () => {
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      taskMetadata: {
        acknowledged_at: 'not-a-timestamp',
        acknowledged_by: assigneeUid,
        acknowledged_via: 'assignee',
      },
    }))).toBe(false);
    expect(hasValidDiagnosticCriticalAcknowledgementReceipt(receipt({
      slaCompletedAt: null,
    }))).toBe(false);
  });
});
