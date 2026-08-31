import { jest } from '@jest/globals';

import {
  resolveMarMedicationExceptionForTerminalOrderTx,
  resolveMarMedicationExceptionTx,
} from '../../services/clinical/marMedicationExceptionService.js';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '10000000-0000-4000-8000-000000000002';
const ASSIGNED_UID = '10000000-0000-4000-8000-000000000003';

function terminalCase({ actorRole = 'DOCTOR' } = {}) {
  return {
    id: '81',
    tenant_id: TENANT_ID,
    status: 'open',
    exception_kind: 'held',
    medication_administration_id: 42,
    clinical_order_id: 91,
    clinical_order_status: 'discontinued',
    task_id: 71,
    assigned_prescriber_uid: ASSIGNED_UID,
    assigned_to_uid: ASSIGNED_UID,
    administration_status: 'held',
    actor_role: actorRole,
  };
}

describe('parent medication-order terminal exception closure', () => {
  test('preserves the original assignee while evidence-completing the task and SLA', async () => {
    const current = terminalCase();
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql, ...args) => {
        if (sql.includes('SELECT exception_case.*')) return [current];
        if (sql.includes('FROM mar_medication_exception_events event')) return [];
        if (sql.includes('INSERT INTO mar_medication_exception_events')) {
          const payload = JSON.parse(args[8]);
          expect(payload).toMatchObject({
            parent_order_terminal_transition: true,
            original_assigned_prescriber_uid: ASSIGNED_UID,
            original_task_assigned_to_uid: ASSIGNED_UID,
            terminal_actor_uid: ACTOR_UID,
          });
          return [{ id: '82', disposition: 'order_stopped', occurred_at: new Date() }];
        }
        if (sql.includes('UPDATE mar_medication_exception_cases')) {
          return [{ ...current, status: 'resolved', resolution_kind: 'order_stopped' }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
      }),
    };
    const completeTaskTx = jest.fn().mockResolvedValue({ id: 71, status: 'completed' });

    const result = await resolveMarMedicationExceptionForTerminalOrderTx(tx, {
      tenantId: TENANT_ID,
      exceptionCaseId: '81',
      reason: 'Therapy stopped by the treating prescriber',
      actorUid: ACTOR_UID,
      commandKey: 'terminal-order:91:dose:42',
      requestFingerprint: 'a'.repeat(64),
      completeTaskTx,
    });

    expect(result.exceptionCase).toMatchObject({
      status: 'resolved',
      assigned_prescriber_uid: ASSIGNED_UID,
      assigned_to_uid: ASSIGNED_UID,
    });
    expect(completeTaskTx).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      id: 71,
      actorUid: ACTOR_UID,
      evidenceKind: 'mar_medication_exception_resolution',
      evidenceResourceType: 'mar_medication_exception_event',
      evidenceResourceId: '82',
      tx,
    }));
  });

  test('rejects administrative authority before inserting terminal evidence', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([terminalCase({ actorRole: 'ADMIN' })]),
    };

    await expect(resolveMarMedicationExceptionForTerminalOrderTx(tx, {
      tenantId: TENANT_ID,
      exceptionCaseId: '81',
      reason: 'Administrative stop',
      actorUid: ACTOR_UID,
      commandKey: 'terminal-order:91:dose:42',
      requestFingerprint: 'b'.repeat(64),
      completeTaskTx: jest.fn(),
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'MAR_ORDER_TERMINAL_PRESCRIBER_REQUIRED',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('medication exception disposition lock order', () => {
  test('locks clinical order, MAR dose, then exception case and task before replay', async () => {
    const statements = [];
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        statements.push(sql);
        if (sql.includes('SELECT clinical_order_id, medication_administration_id, task_id')) {
          return [{ clinical_order_id: 91, medication_administration_id: 42, task_id: 71 }];
        }
        if (sql.includes('FROM clinical_orders')) return [{ id: 91, status: 'verified' }];
        if (sql.includes('FROM medication_administrations')) {
          return [{
            id: 42,
            status: 'scheduled',
            medication_name: 'Contract medicine',
            scheduled_time: new Date(),
          }];
        }
        if (sql.includes('FROM mar_medication_exception_cases exception_case')) {
          return [{
            ...terminalCase(),
            status: 'open',
            clinical_order_status: undefined,
            assigned_to_uid: ACTOR_UID,
            assigned_prescriber_uid: ACTOR_UID,
          }];
        }
        if (sql.includes('FROM users')) return [{ role: 'DOCTOR' }];
        if (sql.includes('FROM mar_medication_exception_events event')) {
          return [{
            id: '82',
            request_fingerprint: 'd'.repeat(64),
            disposition: 'hold_released',
          }];
        }
        throw new Error(`Unexpected SQL: ${sql.slice(0, 100)}`);
      }),
    };

    const result = await resolveMarMedicationExceptionTx(tx, {
      tenantId: TENANT_ID,
      exceptionCaseId: '81',
      disposition: 'hold_released',
      reason: 'Prescriber reviewed and released the held dose',
      actorUid: ACTOR_UID,
      commandKey: 'release-held-dose-42',
      requestFingerprint: 'd'.repeat(64),
      completeTaskTx: jest.fn(),
    });

    const orderLock = statements.findIndex((sql) => (
      sql.includes('FROM clinical_orders') && sql.includes('FOR UPDATE')
    ));
    const marLock = statements.findIndex((sql) => (
      sql.includes('FROM medication_administrations') && sql.includes('FOR UPDATE')
    ));
    const exceptionTaskLock = statements.findIndex((sql) => (
      sql.includes('FOR UPDATE OF exception_case, task')
    ));
    expect(orderLock).toBeGreaterThan(-1);
    expect(marLock).toBeGreaterThan(orderLock);
    expect(exceptionTaskLock).toBeGreaterThan(marLock);
    expect(statements.some((sql) => (
      sql.includes('FOR UPDATE OF exception_case, administration, clinical_order, task')
    ))).toBe(false);
    expect(result).toMatchObject({ replayed: true });
  });
});
