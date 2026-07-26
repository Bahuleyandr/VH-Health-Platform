import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  operations,
  schemas,
} from '../../../scripts/openapi/schemas/portal.mjs';
import { ajvReadySpec } from '../helpers/openapiToAjv.js';

const generatedSpec = JSON.parse(
  readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'),
);

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(
  ajvReadySpec({
    components: { schemas },
  }),
  'portal-openapi',
);

function validatorFor(name) {
  const validate = ajv.getSchema(
    `portal-openapi#/components/schemas/${name}`,
  );
  if (!validate) throw new Error(`Missing portal OpenAPI schema: ${name}`);
  return validate;
}

const safeNextStep = {
  label: 'Complete the blood test',
  explanation: 'Please complete the test before your follow-up appointment.',
  due_date: '2026-07-30',
  status: 'scheduled',
  patient_action: 'Visit the laboratory with your order.',
  responsible_clinician_display_name: 'Dr Meera Rao',
  responsible_clinician_role: 'Doctor',
  safe_contact: null,
  route_token: 'lab_results',
};

const safePendingResult = {
  label: 'Histopathology report',
  status: 'pending',
  responsible_clinician_display_name: 'Dr Meera Rao',
  responsible_clinician_role: 'Doctor',
};

const signedSummary = {
  id: 41,
  admission_id: 73,
  patient_uid: '550e8400-e29b-41d4-a716-446655440000',
  patient_name_snapshot: 'Patient One',
  age_years_snapshot: 54,
  sex_snapshot: 'female',
  hospital_number: 'HN-42',
  admitted_at: '2026-07-20T08:00:00.000Z',
  discharged_at: '2026-07-23T09:00:00.000Z',
  ward_at_discharge: 'Medical ward',
  primary_diagnosis: 'Anaemia',
  secondary_diagnoses: [],
  icd10_codes: ['D64.9'],
  procedures_performed: [],
  status: 'signed',
  signed_by_name: 'Dr Meera Rao',
  signed_by_reg: 'REG-100',
  signed_at: '2026-07-23T08:30:00.000Z',
  delivered_at: null,
  delivery_method: null,
  summary_language: 'en',
  created_at: '2026-07-23T07:30:00.000Z',
  updated_at: '2026-07-23T08:30:00.000Z',
  sections: [
    {
      section_key: 'follow_up',
      section_title: 'Follow-up',
      display_order: 1,
      body: 'Attend the clinic as advised.',
      body_translations: {},
    },
  ],
  pending_results: [safePendingResult],
};

describe('patient portal OpenAPI contracts', () => {
  it('targets real paths in the generated route inventory', () => {
    for (const key of Object.keys(operations)) {
      const [method, path] = key.split(' ');
      expect(generatedSpec.paths[path]?.[method.toLowerCase()]).toBeDefined();
    }
  });

  it('maps both patient-router mounts to the same safe response contracts', () => {
    for (const prefix of ['/api/v1/portal', '/api/v1/patient']) {
      expect(
        operations[`GET ${prefix}/care-plans/whats-next`]?.response,
      ).toBe('PortalWhatsNextResponse');
      expect(
        operations[`GET ${prefix}/discharge-summaries/{id}`]?.response,
      ).toBe('PortalDischargeSummaryResponse');
      expect(
        operations[
          `GET ${prefix}/discharge-summaries/admission/{admissionId}`
        ]?.response,
      ).toBe('PortalDischargeSummaryResponse');
    }
  });

  it('keeps next-step fields strict and route tokens closed', () => {
    const schema = schemas.PortalWhatsNextStep;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(Object.keys(schema.properties)).toEqual([
      'label',
      'explanation',
      'due_date',
      'status',
      'patient_action',
      'responsible_clinician_display_name',
      'responsible_clinician_role',
      'safe_contact',
      'route_token',
    ]);

    const validate = validatorFor('PortalWhatsNextStep');
    expect(validate(safeNextStep)).toBe(true);
    expect(validate({ ...safeNextStep, route_token: 'ward_board' })).toBe(false);

    for (const forbidden of [
      'task_id',
      'blocker_text',
      'staff_comment',
      'ward_note',
      'handoff_id',
      'workflow_run_id',
    ]) {
      expect(schema.properties).not.toHaveProperty(forbidden);
      expect(validate({ ...safeNextStep, [forbidden]: 'internal' })).toBe(false);
    }
  });

  it('preserves live goals and follow-ups while snapshot next steps fail closed', () => {
    expect(schemas.PortalWhatsNextResponse.additionalProperties).toBe(false);
    expect(schemas.PortalWhatsNext.properties.next_steps.maxItems).toBe(0);
    const validate = validatorFor('PortalWhatsNextResponse');
    expect(validate({
      success: true,
      requestId: 'request-whats-next-1',
      data: {
        goals: [],
        follow_ups: [],
        next_steps: [],
        count: 0,
      },
    })).toBe(true);
    expect(validate({
      success: true,
      data: {
        goals: [],
        follow_ups: [],
        next_steps: [safeNextStep],
        count: 1,
      },
    })).toBe(false);
  });

  it('allows only patient-safe pending-result fields', () => {
    const schema = schemas.PortalDischargePendingResult;
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(schema.required);
    expect(Object.keys(schema.properties)).toEqual([
      'label',
      'status',
      'responsible_clinician_display_name',
      'responsible_clinician_role',
    ]);

    const validate = validatorFor('PortalDischargePendingResult');
    expect(validate(safePendingResult)).toBe(true);

    for (const forbidden of [
      'source_type',
      'source_id',
      'result_status',
      'result_value',
      'handoff_state',
      'named_physician_uid',
      'summary_inclusion_timeline_event_id',
      'staff_comment',
      'ward_note',
    ]) {
      expect(schema.properties).not.toHaveProperty(forbidden);
      expect(validate({ ...safePendingResult, [forbidden]: 'internal' }))
        .toBe(false);
    }
  });

  it('accepts signed summaries and rejects draft or internally enriched payloads', () => {
    const schema = schemas.PortalDischargeSummary;
    expect(schema.additionalProperties).toBe(false);
    for (const forbidden of [
      'tenant_id',
      'named_physician_uid',
      'handoff_state',
      'result_value',
      'staff_comment',
      'ward_note',
    ]) {
      expect(schema.properties).not.toHaveProperty(forbidden);
    }
    expect(schemas.PortalDischargeSummaryResponse.additionalProperties)
      .toBe(false);

    const validate = validatorFor('PortalDischargeSummaryResponse');
    expect(validate({
      success: true,
      requestId: 'request-discharge-summary-1',
      data: signedSummary,
    })).toBe(true);
    expect(validate({
      success: true,
      requestId: 'request-discharge-summary-1',
      data: signedSummary,
      internal: true,
    })).toBe(false);
    expect(validate({
      success: true,
      data: { ...signedSummary, status: 'draft' },
    })).toBe(false);
    expect(validate({
      success: true,
      data: {
        ...signedSummary,
        pending_results: [{
          ...safePendingResult,
          preliminary_result: 'internal result content',
        }],
      },
    })).toBe(false);
  });

  it('compiles every portal schema and resolves every local reference', () => {
    for (const name of Object.keys(schemas)) {
      expect(validatorFor(name)).toBeTruthy();
    }
  });
});
