import Ajv from 'ajv';
import addFormats from 'ajv-formats';

import {
  operations,
  schemas,
} from '../../../scripts/openapi/schemas/carePathways.mjs';
import { ajvReadySpec } from '../helpers/openapiToAjv.js';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(
  ajvReadySpec({ components: { schemas } }),
  'care-pathways-s5-openapi',
);

function validatorFor(name) {
  const validate = ajv.getSchema(
    `care-pathways-s5-openapi#/components/schemas/${name}`,
  );
  if (!validate) throw new Error(`Missing S5 OpenAPI schema: ${name}`);
  return validate;
}

const pathwayId = '550e8400-e29b-41d4-a716-446655440001';
const handoffId = '550e8400-e29b-41d4-a716-446655440002';
const senderUid = '550e8400-e29b-41d4-a716-446655440003';
const patientUid = '550e8400-e29b-41d4-a716-446655440004';

describe('care pathways S5 ED OpenAPI contract', () => {
  test('publishes the request, decision, reroute, and role-queue operations', () => {
    expect(
      operations['POST /api/v1/ed/visits/{id}/destination-handoffs'],
    ).toMatchObject({
      request: 'EdDestinationHandoffRequest',
      response: 'EdDestinationHandoffResponse',
      responseStatus: 201,
    });
    expect(
      operations[
        'POST /api/v1/ed/visits/{id}/destination-handoffs/{handoffId}/decisions'
      ],
    ).toMatchObject({
      request: 'EdDestinationHandoffDecisionRequest',
      response: 'EdDestinationHandoffResponse',
    });
    expect(
      operations[
        'POST /api/v1/ed/visits/{id}/destination-handoffs/{handoffId}/reroute'
      ],
    ).toMatchObject({
      request: 'EdDestinationHandoffRequest',
      response: 'EdDestinationHandoffResponse',
      responseStatus: 201,
    });
    expect(
      operations['GET /api/v1/ed/destination-handoffs'],
    ).toMatchObject({ response: 'EdDestinationHandoffListResponse' });
  });

  test('keeps request inputs explicit and rejects arbitrary metadata or timing', () => {
    const validate = validatorFor('EdDestinationHandoffRequest');
    const request = {
      destination: 'icu',
      intended_recipient_role: 'ICU_NURSE',
      reason: 'ICU monitoring is required',
    };
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, destination: 'unknown' })).toBe(false);
    expect(validate({ ...request, due_at: '2026-07-26T10:10:00Z' })).toBe(false);
    expect(validate({ ...request, metadata: { priority: 'critical' } })).toBe(false);
    expect(validate({ ...request, reason: 'control\ntext' })).toBe(false);
  });

  test('requires a reason for decline and never accepts an override field', () => {
    const validate = validatorFor('EdDestinationHandoffDecisionRequest');
    expect(validate({ decision: 'accept' })).toBe(true);
    expect(validate({ decision: 'decline', reason: 'No ICU bed is available' })).toBe(true);
    expect(validate({ decision: 'decline' })).toBe(false);
    expect(validate({ decision: 'accept', override: true })).toBe(false);
  });

  test('returns only the strict handoff, task, transition, and source tuple', () => {
    const response = {
      success: true,
      data: {
        handoff: {
          id: handoffId,
          status: 'requested',
          destination: 'icu',
          intended_recipient_role: 'ICU_NURSE',
          requested_at: '2026-07-26T10:00:00.000Z',
          accepted_at: null,
          declined_at: null,
          accepted_by_uid: null,
          decline_reason: null,
          reroute_reason: null,
        },
        task: {
          id: 91,
          task_kind: 'ed_destination_handoff_review',
          priority: 'high',
          status: 'open',
          assigned_to_role: 'ICU_NURSE',
        },
        transition: {
          transition_key: 'ed_destination_handoff_requested',
          occurred_at: '2026-07-26T10:00:00.000Z',
        },
        destination_source: {
          emergency_visit_id: 73,
          source_pathway_instance_id: pathwayId,
          source_handoff_id: handoffId,
        },
        replayed: false,
      },
    };
    const validate = validatorFor('EdDestinationHandoffResponse');
    expect(validate(response)).toBe(true);
    for (const forbidden of [
      'tenant_id',
      'patient_uid',
      'metadata',
      'idempotency_key',
      'request_fingerprint',
      'policy_due_at',
    ]) {
      expect(
        validate({
          ...response,
          data: { ...response.data, [forbidden]: 'internal' },
        }),
      ).toBe(false);
    }
  });

  test('keeps the role queue bounded and action flags server-derived', () => {
    const validate = validatorFor('EdDestinationHandoffListResponse');
    const item = {
      id: handoffId,
      emergency_visit_id: 73,
      status: 'requested',
      request_reason: 'ICU monitoring is required',
      decline_reason: null,
      reroute_reason: null,
      requested_at: '2026-07-26T10:00:00.000Z',
      accepted_at: null,
      declined_at: null,
      sender_uid: senderUid,
      intended_recipient_role: 'ICU_NURSE',
      accepted_by_uid: null,
      destination: 'icu',
      supersedes_handoff_id: null,
      rerouted_to_handoff_id: null,
      task_id: 91,
      task_status: 'open',
      visit_number: 'ED-2026-73',
      patient_uid: patientUid,
      visit_status: 'awaiting_disposition',
      disposition: null,
      attending_doctor_uid: senderUid,
      arrival_at: '2026-07-26T09:00:00.000Z',
      can_decide: true,
      can_reroute: false,
    };
    expect(validate({
      success: true,
      data: {
        handoffs: [item],
        count: 1,
        actor_role: 'ICU_NURSE',
      },
    })).toBe(true);
    expect(validate({
      success: true,
      data: {
        handoffs: [{ ...item, can_override: true }],
        count: 1,
        actor_role: 'ICU_NURSE',
      },
    })).toBe(false);
  });
});
