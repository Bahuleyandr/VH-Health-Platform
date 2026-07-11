import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as money from '../../../scripts/openapi/schemas/money.mjs';
import * as appointments from '../../../scripts/openapi/schemas/appointments.mjs';
import * as discharge from '../../../scripts/openapi/schemas/discharge.mjs';
import * as payroll from '../../../scripts/openapi/schemas/payroll.mjs';
import * as emr from '../../../scripts/openapi/schemas/emr.mjs';
import * as clinicalAi from '../../../scripts/openapi/schemas/clinicalAi.mjs';
import * as clinicalMar from '../../../scripts/openapi/schemas/clinicalMar.mjs';
import * as pharmacy from '../../../scripts/openapi/schemas/pharmacy.mjs';
import * as users from '../../../scripts/openapi/schemas/users.mjs';
import * as config from '../../../scripts/openapi/schemas/config.mjs';
import * as portal from '../../../scripts/openapi/schemas/portal.mjs';
import * as cathConsumables from '../../../scripts/openapi/schemas/cathConsumables.mjs';
import { ajvReadySpec } from '../helpers/openapiToAjv.js';

// Mirror the generator's SCHEMA_MODULES so the gate covers every overlay.
const MODULES = [
  money,
  appointments,
  discharge,
  payroll,
  emr,
  clinicalAi,
  clinicalMar,
  pharmacy,
  users,
  config,
  portal,
  cathConsumables
];

const __dirname = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(readFileSync(resolve(__dirname, '../../docs/openapi.json'), 'utf8'));

const allOperations = Object.assign({}, ...MODULES.map(m => m.operations || {}));

describe('OpenAPI contract overlays (static gate)', () => {
  it('every overlay key matches a real (METHOD, path) in the generated spec', () => {
    const real = new Set();
    for (const [p, ops] of Object.entries(spec.paths)) {
      for (const m of Object.keys(ops)) real.add(`${m.toUpperCase()} ${p}`);
    }
    const missing = Object.keys(allOperations).filter(k => !real.has(k));
    expect(missing).toEqual([]);
  });

  it('every overlay request/response schema exists in components.schemas', () => {
    const names = new Set(Object.keys(spec.components.schemas));
    const refs = [];
    for (const ov of Object.values(allOperations)) {
      if (ov.request) refs.push(ov.request);
      if (ov.response) refs.push(ov.response);
    }
    const dangling = refs.filter(n => !names.has(n));
    expect(dangling).toEqual([]);
  });

  it('every components.schemas entry compiles under ajv (valid + resolvable $refs)', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(ajvReadySpec(spec), 'openapi.json');
    for (const name of Object.keys(spec.components.schemas)) {
      expect(ajv.getSchema(`openapi.json#/components/schemas/${name}`)).toBeTruthy();
    }
  });

  it('models BIGINT billing source references as safe integers or decimal strings', () => {
    const expectBigIntWire = (schema) => {
      expect(schema.oneOf).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'integer',
          maximum: Number.MAX_SAFE_INTEGER,
        }),
        expect.objectContaining({ type: 'string', pattern: '^[1-9][0-9]*$' }),
      ]));
    };
    for (const schemaName of ['InvoiceItem', 'NonPayableLine', 'AddInvoiceItemRequest']) {
      expectBigIntWire(spec.components.schemas[schemaName].properties.source_ref_id);
    }
    expectBigIntWire(
      spec.components.schemas.CathConsumableBillingLineReference.properties.source_id,
    );

    const cathBigIntFields = {
      CathConsumableCatalogItem: ['id'],
      CathConsumableCatalogUpsertRequest: ['id'],
      CathCaseConsumableUsage: [
        'id',
        'case_id',
        'procedure_log_id',
        'catalog_item_id',
        'implant_record_id',
      ],
      CathConsumableUnbilledUsageItem: ['usage_id', 'case_id', 'procedure_log_id'],
      CathCaseConsumableUsageCreateRequest: ['catalog_item_id', 'procedure_log_id'],
    };
    for (const [schemaName, fieldNames] of Object.entries(cathBigIntFields)) {
      for (const fieldName of fieldNames) {
        expectBigIntWire(spec.components.schemas[schemaName].properties[fieldName]);
      }
    }
  });
});
