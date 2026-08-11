import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { schemas as emrSchemas } from '../../../scripts/openapi/schemas/emr.mjs';

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.resolve(backend, relativePath), 'utf8'));
}

describe('EMR vitals OpenAPI contract', () => {
  it('serializes spo2_scale as numeric enum 1 or 2 and keeps both mirrors exact', () => {
    const schema = emrSchemas.EmrVitalsRequest;
    expect(schema.properties.spo2_scale).toEqual({ type: 'integer', enum: [1, 2] });

    const validate = new Ajv({ strict: false }).compile(schema);
    const request = JSON.parse(JSON.stringify({
      patient_uid: '22222222-2222-4222-8222-222222222222',
      spo2: 88,
      spo2_scale: 2,
    }));
    expect(request.spo2_scale).toBe(2);
    expect(validate(request)).toBe(true);
    expect(validate({ ...request, spo2_scale: '2' })).toBe(false);
    expect(validate({ ...request, spo2_scale: 3 })).toBe(false);

    const canonical = readJson('src/docs/openapi.json');
    const mirror = readJson('../../packages/vhhealth_core/swagger/openapi.json');
    expect(canonical.components.schemas.EmrVitalsRequest).toEqual(schema);
    expect(mirror.components.schemas.EmrVitalsRequest).toEqual(schema);
  });
});
