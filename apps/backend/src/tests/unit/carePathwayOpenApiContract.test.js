import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));

describe('care pathway generated OpenAPI contract', () => {
  it('keeps server-owned start fields out of the public request schema', () => {
    const schema = spec.components.schemas.CarePathwayStartRequest;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'workflow_definition_id',
      'patient_uid',
      'pathway_key',
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'context',
      'encounter_id',
      'metadata',
      'pathway_key',
      'patient_uid',
      'workflow_definition_id',
    ]);
    for (const field of [
      'parent_instance_id',
      'owning_clinician_uid',
      'owning_team_id',
      'accountable_role',
    ]) {
      expect(schema.properties).not.toHaveProperty(field);
    }
  });

  it('documents create and command idempotency with the correct success and path contracts', () => {
    const create = spec.paths['/api/v1/care-pathways/instances'].post;
    const get = spec.paths['/api/v1/care-pathways/instances/{id}'].get;
    const command = spec.paths['/api/v1/care-pathways/instances/{id}/commands'].post;

    expect(Object.keys(create.responses)).toEqual(['201']);
    expect(create.requestBody.required).toBe(true);
    expect(create.requestBody.content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CarePathwayStartRequest');

    for (const operation of [create, command]) {
      expect(operation.parameters).toContainEqual(expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
      }));
    }
    for (const operation of [get, command]) {
      expect(operation.parameters.filter((parameter) => (
        parameter.name === 'id' && parameter.in === 'path'
      ))).toEqual([{
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }]);
    }
  });

  it('documents only explicit claim and accepted-transfer lifecycle mutations', () => {
    const taskClaim = spec.paths['/api/v1/clinical-inbox/tasks/{id}/claim'].post;
    const pathwayClaim = spec.paths['/api/v1/care-pathways/instances/{id}/claim'].post;
    const transferRequest = spec.paths[
      '/api/v1/care-pathways/instances/{id}/owner-transfer-requests'
    ].post;
    const transferAccept = spec.paths[
      '/api/v1/care-pathways/handoffs/{handoffId}/accept'
    ].post;
    const transferDecline = spec.paths[
      '/api/v1/care-pathways/handoffs/{handoffId}/decline'
    ].post;
    const transferCancel = spec.paths[
      '/api/v1/care-pathways/handoffs/{handoffId}/cancel'
    ].post;

    for (const operation of [
      taskClaim,
      pathwayClaim,
      transferRequest,
      transferAccept,
      transferDecline,
      transferCancel,
    ]) {
      expect(operation.parameters).toContainEqual(expect.objectContaining({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
      }));
    }
    expect(taskClaim.parameters).toContainEqual({
      name: 'id',
      in: 'path',
      required: true,
      schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
    });
    for (const operation of [pathwayClaim, transferRequest]) {
      expect(operation.parameters).toContainEqual({
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    }
    for (const operation of [transferAccept, transferDecline, transferCancel]) {
      expect(operation.parameters).toContainEqual({
        name: 'handoffId',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    }

    expect(taskClaim.requestBody).toBeUndefined();
    expect(pathwayClaim.requestBody).toBeUndefined();
    expect(transferAccept.requestBody).toBeUndefined();
    expect(transferRequest.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/CarePathwayOwnerTransferRequest' },
        },
      },
    });

    expect(spec.components.schemas.CarePathwayOwnerTransferRequest).toMatchObject({
      additionalProperties: false,
      required: ['covering_clinician_uid', 'reason'],
    });
    for (const operation of [transferDecline, transferCancel]) {
      expect(operation.requestBody).toEqual({
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CarePathwayTransferDecisionRequest' },
          },
        },
      });
    }
    expect(spec.components.schemas.CarePathwayTransferDecisionRequest).toMatchObject({
      additionalProperties: false,
      required: ['reason'],
      properties: { reason: { type: 'string', minLength: 1 } },
    });
    expect(spec.components.schemas.CarePathwayOwnershipMutationResult.required)
      .toEqual(['instance', 'events', 'replayed']);
    expect(spec.components.schemas.CarePathwayOwnershipMutationResult.properties)
      .not.toHaveProperty('mode');
    expect(spec.paths).not.toHaveProperty('/api/v1/care-pathways/instances/{id}/assign');
    expect(spec.paths).not.toHaveProperty('/api/v1/care-pathways/handoffs/{handoffId}/acknowledge');
  });

  it('documents the non-enumerating exact-recipient covering-transfer read', () => {
    const operation = spec.paths[
      '/api/v1/care-pathways/handoffs/{handoffId}'
    ].get;
    expect(operation.parameters).toContainEqual({
      name: 'handoffId',
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });
    expect(operation.parameters).not.toContainEqual(expect.objectContaining({
      name: 'Idempotency-Key',
    }));
    expect(operation.requestBody).toBeUndefined();
    expect(operation.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CarePathwayOwnerTransferViewResponse');

    const view = spec.components.schemas.CarePathwayOwnerTransferView;
    expect(view.additionalProperties).toBe(false);
    expect(view.required).toEqual([
      'handoff_id',
      'pathway_instance_id',
      'patient_uid',
      'pathway_key',
      'pathway_clinical_status',
      'status',
      'sender_uid',
      'intended_recipient_uid',
      'request_reason',
      'requested_at',
      'accepted_at',
      'declined_at',
      'cancelled_at',
    ]);
    expect(Object.keys(view.properties)).toEqual(view.required);
    expect(view.properties.status.enum)
      .toEqual(['requested', 'accepted', 'declined', 'cancelled']);
    for (const forbidden of [
      'metadata',
      'idempotency_key',
      'task_id',
      'workflow_run_id',
      'request_fingerprint',
    ]) expect(view.properties).not.toHaveProperty(forbidden);
  });
});
