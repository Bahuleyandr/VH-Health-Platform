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
});
