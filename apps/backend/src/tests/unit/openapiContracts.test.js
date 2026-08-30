import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as abdm from '../../../scripts/openapi/schemas/abdm.mjs';
import * as money from '../../../scripts/openapi/schemas/money.mjs';
import * as appointments from '../../../scripts/openapi/schemas/appointments.mjs';
import * as discharge from '../../../scripts/openapi/schemas/discharge.mjs';
import * as payroll from '../../../scripts/openapi/schemas/payroll.mjs';
import * as emr from '../../../scripts/openapi/schemas/emr.mjs';
import * as clinicalAi from '../../../scripts/openapi/schemas/clinicalAi.mjs';
import * as clinicalMar from '../../../scripts/openapi/schemas/clinicalMar.mjs';
import * as pharmacy from '../../../scripts/openapi/schemas/pharmacy.mjs';
import * as wardIndents from '../../../scripts/openapi/schemas/wardIndents.mjs';
import * as users from '../../../scripts/openapi/schemas/users.mjs';
import * as config from '../../../scripts/openapi/schemas/config.mjs';
import * as portal from '../../../scripts/openapi/schemas/portal.mjs';
import * as cathConsumables from '../../../scripts/openapi/schemas/cathConsumables.mjs';
import * as clinicalInbox from '../../../scripts/openapi/schemas/clinicalInbox.mjs';
import * as hl7 from '../../../scripts/openapi/schemas/hl7.mjs';
import * as lab from '../../../scripts/openapi/schemas/lab.mjs';
import * as labCodeMappings from '../../../scripts/openapi/schemas/labCodeMappings.mjs';
import * as nhcx from '../../../scripts/openapi/schemas/nhcx.mjs';
import * as carePathways from '../../../scripts/openapi/schemas/carePathways.mjs';
import * as outboxRecovery from '../../../scripts/openapi/schemas/outboxRecovery.mjs';
import * as clientReadiness from '../../../scripts/openapi/schemas/clientReadiness.mjs';
import * as patientReadiness from '../../../scripts/openapi/schemas/patientReadiness.mjs';
import * as patientFlowTransport from '../../../scripts/openapi/schemas/patientFlowTransport.mjs';
import * as clinicalContinuityPolicyDelivery from '../../../scripts/openapi/schemas/clinicalContinuityPolicyDelivery.mjs';
import * as clinicalContinuityActivationTransitions from '../../../scripts/openapi/schemas/clinicalContinuityActivationTransitions.mjs';
import * as clinicalContinuityReconciliation from '../../../scripts/openapi/schemas/clinicalContinuityReconciliation.mjs';
import * as downtimeWardPacks from '../../../scripts/openapi/schemas/downtimeWardPacks.mjs';
import * as downtimeStaticMirror from '../../../scripts/openapi/schemas/downtimeStaticMirror.mjs';
import * as continuityFacilityContextGrants from '../../../scripts/openapi/schemas/continuityFacilityContextGrants.mjs';
import * as publicPaymentPage from '../../../scripts/openapi/schemas/publicPaymentPage.mjs';
import * as firebaseAuth from '../../../scripts/openapi/schemas/firebaseAuth.mjs';
import * as abdmAbhaRegistration from '../../../scripts/openapi/schemas/abdmAbhaRegistration.mjs';
import * as devices from '../../../scripts/openapi/schemas/devices.mjs';
import * as health from '../../../scripts/openapi/schemas/health.mjs';
import * as pharmacyCounterSale from '../../../scripts/openapi/schemas/pharmacyCounterSale.mjs';
import * as dietaryKitchen from '../../../scripts/openapi/schemas/dietaryKitchen.mjs';
import * as drugKb from '../../../scripts/openapi/schemas/drugKb.mjs';
import * as misReportSchedules from '../../../scripts/openapi/schemas/misReportSchedules.mjs';
import * as referralFacilities from '../../../scripts/openapi/schemas/referralFacilities.mjs';
import * as shiftSwapOnCall from '../../../scripts/openapi/schemas/shiftSwapOnCall.mjs';
import * as ambulanceTracking from '../../../scripts/openapi/schemas/ambulanceTracking.mjs';
import * as paymentGateway from '../../../scripts/openapi/schemas/paymentGateway.mjs';
import * as smsConfig from '../../../scripts/openapi/schemas/smsConfig.mjs';
import * as abdmCompletion from '../../../scripts/openapi/schemas/abdmCompletion.mjs';
import * as facilityAssets from '../../../scripts/openapi/schemas/facilityAssets.mjs';
import * as integrationGates from '../../../scripts/openapi/schemas/integrationGates.mjs';
import * as terminology from '../../../scripts/openapi/schemas/terminology.mjs';
import * as uhi from '../../../scripts/openapi/schemas/uhi.mjs';
import { ajvReadySpec } from '../helpers/openapiToAjv.js';

// Mirror the generator's SCHEMA_MODULES so the gate covers every overlay.
const MODULES = [
  abdm,
  money,
  appointments,
  discharge,
  payroll,
  emr,
  clinicalAi,
  clinicalMar,
  pharmacy,
  wardIndents,
  users,
  config,
  portal,
  cathConsumables,
  clinicalInbox,
  hl7,
  lab,
  labCodeMappings,
  nhcx,
  carePathways,
  outboxRecovery,
  clinicalContinuityActivationTransitions,
  clinicalContinuityPolicyDelivery,
  clientReadiness,
  patientReadiness,
  patientFlowTransport,
  clinicalContinuityReconciliation,
  downtimeWardPacks,
  downtimeStaticMirror,
  continuityFacilityContextGrants,
  publicPaymentPage,
  firebaseAuth,
  abdmAbhaRegistration,
  devices,
  health,
  pharmacyCounterSale,
  dietaryKitchen,
  drugKb,
  misReportSchedules,
  referralFacilities,
  shiftSwapOnCall,
  ambulanceTracking,
  paymentGateway,
  smsConfig,
  abdmCompletion,
  facilityAssets,
  integrationGates,
  terminology,
  uhi
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
      if (ov.requestContent) refs.push(...Object.values(ov.requestContent));
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

  it('documents exact SMS callback forms and write-only credential handling', () => {
    const msg91 = spec.paths['/webhooks/sms/dlr/{token}'].post;
    expect(msg91.security).toEqual([]);
    expect(msg91.requestBody.content).toEqual({
      'application/x-www-form-urlencoded': {
        schema: { $ref: '#/components/schemas/Msg91DlrFormRequest' },
      },
      'application/json': {
        schema: { $ref: '#/components/schemas/Msg91DlrJsonRequest' },
      },
    });
    expect(Object.keys(msg91.responses)).toEqual(['200', '400', '401', '413', '429', '500']);

    const twilio = spec.paths['/webhooks/sms/twilio-status/{token}'].post;
    expect(twilio.security).toEqual([]);
    expect(twilio.requestBody.content).toEqual({
      'application/x-www-form-urlencoded': {
        schema: { $ref: '#/components/schemas/TwilioSmsStatusFormRequest' },
      },
    });
    expect(twilio.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'X-Twilio-Signature', in: 'header', required: true }),
    ]));
    expect(spec.components.schemas.SmsProviderConfigUpsertRequest.properties.auth_key)
      .toMatchObject({ writeOnly: true });
    expect(spec.components.schemas.SmsProviderConfigView.properties.callback_token)
      .toMatchObject({ readOnly: true });
  });

  it('documents the counter-sale witness approval handshake and final approval id', () => {
    const createSchema = spec.components.schemas.PharmacyCounterSaleCreateRequest;
    const counterDecision =
      spec.components.schemas.PharmacyCounterSaleWitnessApprovalDecisionRequest;
    const inventoryDispense =
      spec.components.schemas.PharmacyInventoryControlledDispenseRequest;
    const inventoryMovement =
      spec.components.schemas.PharmacyInventoryMovementRequest;
    const movementApprovalRequest =
      spec.components.schemas.PharmacyInventoryMovementWitnessApprovalRequest;
    expect(createSchema.properties.witness).toBeUndefined();
    expect(createSchema.properties.witness_approval_id).toEqual(expect.objectContaining({
      type: 'string',
      pattern: '^[1-9][0-9]*$',
    }));
    const counterRequest = spec.components.schemas.PharmacyCounterSaleWitnessApprovalRequest;
    expect(counterRequest.properties.witness_approval_id).toBeUndefined();
    expect(counterDecision.additionalProperties).toBe(false);
    expect(counterDecision.oneOf).toEqual([
      { required: ['employeeId', 'password'] },
      {
        not: {
          anyOf: [
            { required: ['employeeId'] },
            { required: ['password'] },
          ],
        },
      },
    ]);
    expect(inventoryDispense.required).toEqual([
      'inventory_item_id', 'inventory_batch_id', 'quantity',
    ]);
    expect(inventoryDispense.properties.witness).toBeUndefined();
    expect(inventoryDispense.properties.witness_approval_id).toEqual(expect.objectContaining({
      type: 'string',
      pattern: '^[1-9][0-9]*$',
    }));
    expect(inventoryDispense.properties.require_usable_batch).toBeUndefined();
    expect(inventoryDispense.properties.performed_by_name).toBeUndefined();
    const inventoryRequest = spec.components.schemas.PharmacyInventoryWitnessApprovalRequest;
    expect(inventoryRequest.required).toEqual([
      'inventory_item_id', 'inventory_batch_id', 'quantity',
    ]);
    expect(inventoryMovement.properties.witness_uid).toBeUndefined();
    expect(inventoryMovement.properties.witness_name).toBeUndefined();
    expect(inventoryMovement.properties.performed_by).toBeUndefined();
    expect(inventoryMovement.properties.performed_by_name).toBeUndefined();
    expect(inventoryMovement.properties.require_usable_batch).toBeUndefined();
    expect(inventoryMovement.properties.witness_approval_id).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]*$',
    });
    expect(movementApprovalRequest.required).toEqual([
      'inventory_item_id', 'inventory_batch_id', 'movement_kind', 'quantity',
    ]);
    expect(movementApprovalRequest.properties.movement_kind.enum).toEqual([
      'transfer_out', 'adjust_decrease', 'dispose', 'expire',
    ]);
    expect(movementApprovalRequest.properties.witness_uid).toBeUndefined();
    expect(movementApprovalRequest.properties.witness_name).toBeUndefined();

    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const bearerSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];
      const finalSale = spec.paths[`${prefix}/counter-sales`]?.post;
      const requestApproval = spec.paths[`${prefix}/counter-sales/witness-approvals`]?.post;
      const approve = spec.paths[`${prefix}/counter-sales/witness-approvals/{id}/approve`]?.post;
      const finalDispense = spec.paths[`${prefix}/inventory/v2/controlled-dispense`]?.post;
      const finalMovement = spec.paths[`${prefix}/inventory/v2/movements`]?.post;
      expect(finalSale?.security).toEqual(bearerSecurity);
      expect(requestApproval?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyCounterSaleWitnessApprovalRequest',
      });
      expect(approve?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyCounterSaleWitnessApprovalDecisionRequest',
      });
      expect(approve?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
          schema: expect.objectContaining({
            type: 'string',
            pattern: '^[1-9][0-9]{0,18}$',
            minLength: 1,
            maxLength: 19,
            'x-maximum': '9223372036854775807',
          }),
        }),
      ]));
      expect(finalDispense?.security).toEqual(bearerSecurity);
      expect(finalDispense?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryControlledDispenseRequest',
      });
      expect(finalDispense?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryControlledDispenseResponse',
      });
      const inventoryRequest = spec.paths[
        `${prefix}/inventory/v2/controlled-dispense/witness-approvals`
      ]?.post;
      const inventoryApprove = spec.paths[
        `${prefix}/inventory/v2/controlled-dispense/witness-approvals/{id}/approve`
      ]?.post;
      const movementRequest = spec.paths[
        `${prefix}/inventory/v2/movements/witness-approvals`
      ]?.post;
      const movementApprove = spec.paths[
        `${prefix}/inventory/v2/movements/witness-approvals/{id}/approve`
      ]?.post;
      expect(inventoryRequest?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryWitnessApprovalRequest',
      });
      expect(inventoryApprove?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryWitnessApprovalDecisionRequest',
      });
      expect(inventoryApprove?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
          schema: expect.objectContaining({
            type: 'string',
            pattern: '^[1-9][0-9]{0,18}$',
            minLength: 1,
            maxLength: 19,
            'x-maximum': '9223372036854775807',
          }),
        }),
      ]));
      expect(finalMovement?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryMovementRequest',
      });
      expect(movementRequest?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryMovementWitnessApprovalRequest',
      });
      expect(movementApprove?.requestBody?.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/PharmacyInventoryMovementWitnessApprovalDecisionRequest',
      });
      expect(movementApprove?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          in: 'path',
          required: true,
          schema: expect.objectContaining({
            type: 'string',
            pattern: '^[1-9][0-9]{0,18}$',
            minLength: 1,
            maxLength: 19,
            'x-maximum': '9223372036854775807',
          }),
        }),
      ]));
      for (const operation of [
        finalSale,
        requestApproval,
        approve,
        finalDispense,
        inventoryRequest,
        inventoryApprove,
        finalMovement,
        movementRequest,
        movementApprove,
      ]) {
        expect(operation?.security).toEqual(bearerSecurity);
        for (const status of ['400', '401', '403', '404', '409', '429', '500']) {
          expect(operation?.responses?.[status]?.content?.['application/json']?.schema).toEqual({
            $ref: '#/components/schemas/PharmacyControlledDispenseWitnessErrorResponse',
          });
        }
      }
      for (const operation of [
        finalSale,
        requestApproval,
        approve,
        finalDispense,
        inventoryRequest,
        inventoryApprove,
        finalMovement,
        movementRequest,
        movementApprove,
      ]) {
        expect(operation?.parameters).toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ]));
        for (const status of ['422', '503']) {
          expect(operation?.responses?.[status]?.content?.['application/json']?.schema).toEqual({
            $ref: '#/components/schemas/PharmacyControlledDispenseWitnessErrorResponse',
          });
        }
      }
      for (const operation of [
        inventoryRequest,
        inventoryApprove,
        movementRequest,
        movementApprove,
      ]) {
        expect(operation?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
          $ref: '#/components/schemas/PharmacyInventoryWitnessApprovalResponse',
        });
      }
    }
  });

  it('enforces the exact counter-sale witness credential pair', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(ajvReadySpec(spec), 'openapi.json');
    const validate = ajv.getSchema(
      'openapi.json#/components/schemas/PharmacyCounterSaleWitnessApprovalDecisionRequest',
    );
    const sale = {
      lines: [{ inventory_item_id: 17, quantity: 1 }],
      payment_mode: 'CASH',
    };

    expect(validate({ sale })).toBe(true);
    expect(validate({
      sale,
      employeeId: 'NURSE-002',
      password: 'witness-secret',
    })).toBe(true);
    expect(validate({ sale, employeeId: 'NURSE-002' })).toBe(false);
    expect(validate({ sale, password: 'witness-secret' })).toBe(false);
    expect(validate({ sale, employeeId: 'NURSE-002', password: 'witness-secret', uid: 'spoof' }))
      .toBe(false);
  });

  it('keeps facility-bound witness approvals strict and separate from clinical witnesses', () => {
    const pendingKeys = [
      'contract',
      'expires_at',
      'id',
      'payload',
      'payload_fingerprint',
      'requested_by',
      'scope',
      'status',
    ];
    const approvedKeys = [...pendingKeys, 'witness'].sort();
    const clinicalScopes = [
      'pharmacy_counter_sale',
      'pharmacy_dispense_substitution',
      'ward_indent_controlled_handoff',
    ];
    const clinicalRoles = [
      'PHARMACY_STAFF',
      'PHARMACY_INCHARGE',
      'DOCTOR',
      'DUTY_DOCTOR',
      'MEDICAL_SUPERINTENDENT',
      'NURSING_STAFF',
      'NURSING_INCHARGE',
      'IP_STAFF_NURSE',
      'IP_INCHARGE',
      'OP_STAFF_NURSE',
      'OP_INCHARGE',
    ];
    const exactApproval = (schema, scopes, payloadSchema, witnessSchema) => {
      expect(schema.oneOf).toHaveLength(2);
      const pending = schema.oneOf.find(({ properties }) => (
        properties.status.enum[0] === 'pending'
      ));
      const approved = schema.oneOf.find(({ properties }) => (
        properties.status.enum[0] === 'approved'
      ));

      expect(pending.additionalProperties).toBe(false);
      expect(Object.keys(pending.properties).sort()).toEqual(pendingKeys);
      expect([...pending.required].sort()).toEqual(pendingKeys);
      expect(pending.properties.witness).toBeUndefined();
      expect(pending.properties.status).toEqual({ type: 'string', enum: ['pending'] });
      expect(approved.additionalProperties).toBe(false);
      expect(Object.keys(approved.properties).sort()).toEqual(approvedKeys);
      expect([...approved.required].sort()).toEqual(approvedKeys);
      expect(approved.properties.status).toEqual({ type: 'string', enum: ['approved'] });
      expect(pending.properties.contract).toEqual({
        type: 'string', enum: ['controlled_dispense_witness_v1'],
      });
      expect(pending.properties.id).toMatchObject({
        type: 'string',
        pattern: '^[1-9][0-9]{0,18}$',
        minLength: 1,
        maxLength: 19,
        'x-maximum': '9223372036854775807',
      });
      expect(pending.properties.scope).toEqual({ type: 'string', enum: scopes });
      expect(pending.properties.requested_by).toEqual({ type: 'string', format: 'uuid' });
      expect(pending.properties.payload).toEqual(payloadSchema);
      expect(pending.properties.payload_fingerprint).toEqual({
        type: 'string', pattern: '^[a-f0-9]{64}$',
      });
      expect(pending.properties.expires_at).toEqual({ type: 'string', format: 'date-time' });
      expect(approved.properties.witness).toEqual(witnessSchema);
    };

    const clinicalWitness =
      pharmacyCounterSale.schemas.PharmacyClinicalControlledWitnessIdentity;
    const facilityWitness =
      pharmacyCounterSale.schemas.PharmacyFacilityBoundControlledWitnessIdentity;
    expect(clinicalWitness.additionalProperties).toBe(false);
    expect([...clinicalWitness.required].sort()).toEqual(['name', 'role', 'uid']);
    expect(Object.keys(clinicalWitness.properties).sort()).toEqual(['name', 'role', 'uid']);
    expect(clinicalWitness.properties.uid).toEqual({ type: 'string', format: 'uuid' });
    expect(clinicalWitness.properties.name).toEqual({ type: 'string', minLength: 1 });
    expect(clinicalWitness.properties.role.enum).toEqual(clinicalRoles);
    expect(clinicalWitness.properties.facility_grant_id).toBeUndefined();
    expect(facilityWitness.additionalProperties).toBe(false);
    expect([...facilityWitness.required].sort()).toEqual([
      'facility_grant_id', 'name', 'role', 'uid',
    ]);
    expect(Object.keys(facilityWitness.properties).sort()).toEqual([
      'facility_grant_id', 'name', 'role', 'uid',
    ]);
    expect(facilityWitness.properties.uid).toEqual({ type: 'string', format: 'uuid' });
    expect(facilityWitness.properties.name).toEqual({ type: 'string', minLength: 1 });
    expect(facilityWitness.properties.role.enum).toEqual([
      'PHARMACY_STAFF', 'PHARMACY_INCHARGE',
    ]);
    expect(facilityWitness.properties.facility_grant_id).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]{0,18}$',
      minLength: 1,
      maxLength: 19,
      'x-maximum': '9223372036854775807',
    });

    exactApproval(
      pharmacyCounterSale.schemas.PharmacyCounterSaleWitnessApproval,
      clinicalScopes,
      { type: 'object', additionalProperties: true },
      { $ref: '#/components/schemas/PharmacyClinicalControlledWitnessIdentity' },
    );
    exactApproval(
      pharmacyCounterSale.schemas.PharmacyInventoryDisposalWitnessApproval,
      ['pharmacy_inventory_controlled_disposal'],
      { $ref: '#/components/schemas/PharmacyInventoryDisposalWitnessPayload' },
      { $ref: '#/components/schemas/PharmacyFacilityBoundControlledWitnessIdentity' },
    );
    exactApproval(
      pharmacy.schemas.PharmacyOrderControlledWitnessApproval,
      ['pharmacy_order_inventory_dispense'],
      { $ref: '#/components/schemas/PharmacyOrderControlledWitnessPayload' },
      { $ref: '#/components/schemas/PharmacyFacilityBoundControlledWitnessIdentity' },
    );

    expect(pharmacyCounterSale.schemas.PharmacyCounterSaleWitnessApprovalResponse
      .properties.data).toEqual({
      $ref: '#/components/schemas/PharmacyCounterSaleWitnessApproval',
    });
    expect(pharmacy.schemas.PharmacySubstitutionWitnessApprovalResponse.properties.data)
      .toEqual({ $ref: '#/components/schemas/PharmacyCounterSaleWitnessApproval' });
    expect(pharmacyCounterSale.schemas.PharmacyInventoryDisposalWitnessApprovalResponse
      .properties.data).toEqual({
      $ref: '#/components/schemas/PharmacyInventoryDisposalWitnessApproval',
    });
    expect(pharmacy.schemas.PharmacyOrderControlledWitnessResponse.properties.data).toEqual({
      $ref: '#/components/schemas/PharmacyOrderControlledWitnessApproval',
    });

    const orderPayload = pharmacy.schemas.PharmacyOrderControlledWitnessPayload;
    const orderPayloadKeys = [
      'batch_number',
      'batch_safety_contract',
      'contract',
      'expiry_date',
      'facility_id',
      'inventory_batch_id',
      'inventory_item_id',
      'lot_number',
      'operation',
      'order_catalog_id',
      'order_dispensed_quantity',
      'order_id',
      'order_inventory_authority_version',
      'order_line_index',
      'order_ordered_quantity',
      'order_remaining_quantity',
      'order_status',
      'patient_uid',
      'prescriber_uid',
      'prescriber_user_id',
      'prescription_catalog_id',
      'prescription_dispensed_quantity',
      'prescription_id',
      'prescription_lifecycle_status',
      'prescription_line_index',
      'prescription_locked_at',
      'prescription_locked_by',
      'prescription_number',
      'prescription_ordered_quantity',
      'prescription_remaining_quantity',
      'prescription_revision',
      'prescription_signed_at',
      'prescription_signed_by',
      'prescription_status',
      'quantity',
      'requester_facility_grant_id',
      'requester_facility_role',
    ].sort();
    expect(orderPayload.additionalProperties).toBe(false);
    expect(Object.keys(orderPayload.properties).sort()).toEqual(orderPayloadKeys);
    expect([...orderPayload.required].sort()).toEqual(orderPayloadKeys);

    const disposalPayload =
      pharmacyCounterSale.schemas.PharmacyInventoryDisposalWitnessPayload;
    const disposalPayloadKeys = [
      'authority_reference',
      'batch_number',
      'catalog_id',
      'contract',
      'disposition_method',
      'expiry_date',
      'facility_grant_id',
      'facility_id',
      'inventory_batch_id',
      'inventory_item_id',
      'lot_number',
      'notes',
      'performer_role',
      'quantity',
      'reason_code',
      'source_batch_status',
      'storage_location_id',
      'supplier_id',
    ];
    expect(disposalPayload.additionalProperties).toBe(false);
    expect(Object.keys(disposalPayload.properties).sort()).toEqual(disposalPayloadKeys);
    expect([...disposalPayload.required].sort()).toEqual(disposalPayloadKeys);
    expect(disposalPayload.properties.performer_role.enum).toEqual([
      'PHARMACY_STAFF', 'PHARMACY_INCHARGE',
    ]);
    expect(disposalPayload.properties.facility_grant_id).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]{0,18}$',
      minLength: 1,
      maxLength: 19,
      'x-maximum': '9223372036854775807',
    });

    const approvalIdSchema = expect.objectContaining({
      type: 'string',
      pattern: '^[1-9][0-9]{0,18}$',
      minLength: 1,
      maxLength: 19,
      'x-maximum': '9223372036854775807',
    });
    const orderIdSchema = { type: 'integer', minimum: 1, maximum: 2147483647 };
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const orderRequest = pharmacy.operations[
        `POST ${prefix}/orders/{id}/controlled-dispense/witness-approvals`
      ];
      const orderApprove = pharmacy.operations[
        `POST ${prefix}/orders/{id}/controlled-dispense/witness-approvals/{approvalId}/approve`
      ];
      const disposalRequest = pharmacyCounterSale.operations[
        `POST ${prefix}/inventory/v2/disposals/witness-approvals`
      ];
      const disposalApprove = pharmacyCounterSale.operations[
        `POST ${prefix}/inventory/v2/disposals/witness-approvals/{id}/approve`
      ];
      const clinicalApprove = pharmacyCounterSale.operations[
        `POST ${prefix}/counter-sales/witness-approvals/{id}/approve`
      ];

      expect(orderRequest).toMatchObject({
        request: 'PharmacyOrderControlledWitnessSelection',
        response: 'PharmacyOrderControlledWitnessResponse',
      });
      expect(orderApprove).toMatchObject({
        request: 'PharmacyOrderControlledWitnessDecisionRequest',
        response: 'PharmacyOrderControlledWitnessResponse',
      });
      expect(orderRequest.pathParameters.id).toEqual(orderIdSchema);
      expect(orderApprove.pathParameters.id).toEqual(orderIdSchema);
      expect(orderApprove.pathParameters.approvalId).toEqual(approvalIdSchema);
      expect(disposalRequest).toMatchObject({
        request: 'PharmacyInventoryDisposalWitnessApprovalRequest',
        response: 'PharmacyInventoryDisposalWitnessApprovalResponse',
      });
      expect(disposalApprove).toMatchObject({
        request: 'PharmacyInventoryDisposalWitnessApprovalDecisionRequest',
        response: 'PharmacyInventoryDisposalWitnessApprovalResponse',
      });
      expect(disposalApprove.pathParameters.id).toEqual(approvalIdSchema);
      for (const operation of [orderRequest, orderApprove, disposalRequest, disposalApprove]) {
        expect(operation.description).toMatch(/ACTIVE grant/);
        expect(operation.description).toMatch(/pharmacy operator|PHARMACY_STAFF/);
        expect(operation.description).toMatch(/exact (?:order |disposal )?facility/);
        expect(operation.description).not.toMatch(/medical or nursing|clinical witness/i);
      }
      expect(clinicalApprove.description).toMatch(/pharmacy, medical, or nursing witness/);
      expect(clinicalApprove.response).toBe('PharmacyCounterSaleWitnessApprovalResponse');
    }
  });

  it('publishes the tenant/facility pharmacy order authority contract end to end', () => {
    const idempotencyHeader = expect.objectContaining({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
    });
    const positiveOrderId = expect.objectContaining({
      name: 'id',
      in: 'path',
      required: true,
      schema: {
        type: 'integer', minimum: 1, maximum: 2147483647,
      },
    });
    const line = spec.components.schemas.PharmacyOrderLine;
    const queueItem = spec.components.schemas.PharmacyOrderQueueItem;
    const queueResponse = spec.components.schemas.PharmacyOrderQueueResponse;
    const lineIdentityRequest =
      spec.components.schemas.PharmacyOrderLineIdentityResolutionRequest;
    const lineIdentityResult =
      spec.components.schemas.PharmacyOrderLineIdentityResolutionResult;
    const manualLine = spec.components.schemas.PharmacyOrderManualConfirmationLine;
    const counterLine = spec.components.schemas.PharmacyCounterDispenseLine;
    const counterRequest = spec.components.schemas.PharmacyCounterDispenseRequest;
    const bodyCounterRequest = spec.components.schemas.PharmacyBodyCounterDispenseRequest;
    const substitution = spec.components.schemas.PharmacyDispenseSubstitutionRequest;
    const substitutionWitness =
      spec.components.schemas.PharmacySubstitutionWitnessApprovalRequest;
    const supplyMovement = spec.components.schemas.PharmacySupplyStockMovementRequest;
    const authenticatedSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];

    expect(line.required).toEqual(['order_line_index', 'catalog_id']);
    expect(queueItem.properties.items_list.items).toEqual({
      $ref: '#/components/schemas/PharmacyOrderQueueLine',
    });
    expect(spec.components.schemas.PharmacyOrderQueueLine.properties).toMatchObject({
      order_line_index: { type: 'integer', minimum: 0 },
      prescription_line_index: { type: 'integer', minimum: 0, nullable: true },
    });
    expect(queueItem.properties.prescription_medications.items).toEqual({
      $ref: '#/components/schemas/PharmacyPrescriptionMedication',
    });
    expect(queueItem.properties.line_identity_recovery_required).toEqual({ type: 'boolean' });
    expect(queueItem.required).toEqual(expect.arrayContaining([
      'payment_mode', 'amount_collected', 'payment_metadata',
    ]));
    expect(queueItem.properties.funding_recovery).toEqual({
      nullable: true,
      allOf: [{ $ref: '#/components/schemas/PharmacyFundingRecoveryTask' }],
    });
    expect(spec.components.schemas.PharmacyFundingRecoveryTask).toMatchObject({
      additionalProperties: false,
      required: [
        'task_id', 'status', 'owner_role', 'pharmacy_order_id',
        'invoice_item_id', 'order_version', 'order_items_sha256', 'deep_link',
      ],
      properties: {
        status: { type: 'string' },
        owner_role: { type: 'string' },
        deep_link: {
          type: 'string',
          format: 'uri-reference',
          pattern:
            '^/billing-desk\\?pharmacy_order_id=[1-9][0-9]*&invoice_item_id=[1-9][0-9]*(&tpa_claim_id=[1-9][0-9]*)?$',
        },
      },
    });
    expect(queueResponse.properties.requestId).toEqual({ type: 'string', nullable: true });
    expect(spec.components.schemas.PharmacyOrderMutationResponse.properties.requestId)
      .toEqual({ type: 'string', nullable: true });
    expect(spec.components.schemas.PharmacyOrderDispensableContext.required)
      .toContain('tpa_reference');
    expect(spec.components.schemas.PharmacyOrderDispensableContext.properties.tpa_reference)
      .toEqual({ type: 'string', nullable: true });
    expect(spec.components.schemas.PharmacyOrderDispenseRecoveryDetails.properties)
      .toMatchObject({
        next_action: { type: 'string' },
        payment_mode: { type: 'string', nullable: true },
        tpa_reference: { type: 'string', nullable: true },
        clinical_verification_status: { type: 'string', nullable: true },
        manual_allergy_review_required: { type: 'boolean', nullable: true },
        funding_recovery: {
          nullable: true,
          allOf: [{ $ref: '#/components/schemas/PharmacyFundingRecoveryTask' }],
        },
      });
    expect(spec.components.schemas.PharmacyOrderVerificationRequest.required)
      .toEqual(['decision']);
    expect(spec.components.schemas.PharmacyOrderVerificationRequest.properties
      .manual_allergy_review_completed).toMatchObject({ type: 'boolean' });
    expect(spec.components.schemas.PharmacyOrderVerificationRequest.oneOf)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            decision: { enum: ['rejected'] },
            notes: { type: 'string', minLength: 10, maxLength: 500 },
          }),
          required: ['notes'],
        }),
      ]));
    expect(spec.components.schemas.PharmacyOrderCancelRequest.required)
      .toEqual(['cancellation_reason']);
    expect(spec.components.schemas.PharmacyOrderCancelRequest.properties.cancellation_reason)
      .toMatchObject({ type: 'string', minLength: 3, maxLength: 500 });
    expect(spec.components.schemas.PharmacyOrderUnavailableRequest.required)
      .toEqual(['reason']);
    expect(spec.components.schemas.PharmacyOrderUnavailableRequest.properties.reason)
      .toEqual({ type: 'string', minLength: 1, maxLength: 500 });
    expect(spec.components.schemas.PharmacyOrderDeliveryRequest.required)
      .toEqual(['handoff_token']);
    expect(spec.components.schemas.PharmacyOrderDispatchRequest.required)
      .toEqual(['delivery_assignee_uid']);
    expect(spec.components.schemas.PharmacyOrderDispatchRequest.properties)
      .not.toHaveProperty('delivery_person');
    expect(spec.components.schemas.PharmacyOrderDispatchRequest.properties)
      .not.toHaveProperty('delivery_person_phone');
    expect(lineIdentityRequest.required).toEqual(['line_mappings']);
    expect(lineIdentityRequest.properties.line_mappings).toMatchObject({
      type: 'array', minItems: 1, maxItems: 100,
      items: { $ref: '#/components/schemas/PharmacyOrderLineIdentityMapping' },
    });
    expect(lineIdentityResult.properties.items_list.items).toEqual({
      $ref: '#/components/schemas/PharmacyOrderLineIdentityResolutionLine',
    });
    expect(spec.components.schemas.PharmacyOrderLineIdentityResolutionLine.required).toEqual([
      'order_line_index', 'prescription_line_index', 'catalog_id',
    ]);
    expect(manualLine.properties.inventory_item_id).toEqual({
      type: 'integer', minimum: 1, maximum: 2147483647,
    });
    expect(manualLine.properties.quantity).toEqual({
      type: 'number', minimum: 0.0001,
      maximum: 9999999999.9999, multipleOf: 0.0001,
    });
    expect(spec.components.schemas.PharmacyOrderInventoryAllocation.properties.quantity)
      .toEqual({
        type: 'number', minimum: 0.0001,
        maximum: 9999999999.9999, multipleOf: 0.0001,
      });
    for (const quantityName of [
      'dispensed_quantity', 'dispensed_qty', 'qty', 'quantity', 'dispensed_quantity_ml',
    ]) {
      expect(counterLine.properties[quantityName]).toMatchObject({
        type: 'number', minimum: 0, exclusiveMinimum: true,
      });
    }
    for (const quantityName of ['dispensed_quantity', 'dispensed_qty', 'qty', 'quantity']) {
      expect(counterLine.properties[quantityName]).toMatchObject({
        maximum: 9999999999.9999, multipleOf: 0.0001,
      });
    }
    for (const request of [counterRequest, bodyCounterRequest]) {
      expect(request.required).toEqual(['payment_mode', 'amount_collected']);
      expect(request.properties.payment_mode.enum).toEqual([
        'cash', 'card', 'upi', 'wallet', 'corporate_tpa', 'insurance', 'none',
      ]);
      expect(request.properties.payment_method.enum).not.toContain('package');
      expect(request.properties.payment_method.enum).not.toContain('credit');
      expect(request.properties.tpa_reference).toEqual({
        type: 'string', minLength: 1, maxLength: 160,
      });
    }
    expect(spec.components.schemas.PharmacyCounterDispenseResult.properties.status.enum)
      .toEqual(['PARTIALLY_DISPENSED', 'DISPENSED']);
    for (const request of [substitution, substitutionWitness]) {
      expect(request.properties.performed_by_name).toBeUndefined();
      expect(request.properties.encounter_id).toMatchObject({
        type: 'integer', minimum: 1, nullable: true,
      });
      expect(request.properties.payment_mode.enum).toEqual([
        'cash', 'card', 'upi', 'wallet', 'insurance', 'corporate_tpa',
      ]);
      expect(request.properties.amount_collected).toMatchObject({
        type: 'number', minimum: 0,
      });
      expect(request.properties.tpa_reference).toMatchObject({
        type: 'string', minLength: 1, maxLength: 160,
      });
      expect(request.required).toEqual(expect.arrayContaining([
        'payment_mode', 'amount_collected',
      ]));
    }
    expect(supplyMovement.properties.performed_by_name).toBeUndefined();

    const lifecycle = {
      '/orders/{id}/confirm': ['PharmacyOrderConfirmationRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/verify': ['PharmacyOrderVerificationRequest', 'PharmacyOrderVerificationResponse'],
      '/orders/{id}/dispatch': ['PharmacyOrderDispatchRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/delivered': ['PharmacyOrderDeliveryRequest', 'PharmacyOrderDeliveryResponse'],
      '/orders/{id}/delivery-handoff/reissue': ['PharmacyDeliveryHandoffReissueRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/delivery-return/request': ['PharmacyDeliveryReturnRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/delivery-return/complete': ['PharmacyDeliveryReturnCompletionRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/dispense-counter': ['PharmacyCounterDispenseRequest', 'PharmacyCounterDispenseResponse'],
      '/orders/{id}/dispense': ['PharmacyCounterDispenseRequest', 'PharmacyCounterDispenseResponse'],
      '/orders/{id}/unavailable': ['PharmacyOrderUnavailableRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/cancel': ['PharmacyOrderCancelRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/assign-facility': ['PharmacyOrderFacilityAssignmentRequest', 'PharmacyOrderMutationResponse'],
      '/orders/{id}/resolve-line-identities': [
        'PharmacyOrderLineIdentityResolutionRequest',
        'PharmacyOrderLineIdentityResolutionResponse',
      ],
    };
    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      for (const queueSuffix of ['/orders', '/orders/queue']) {
        const operation = spec.paths[`${prefix}${queueSuffix}`].get;
        expect(operation.security).toEqual(authenticatedSecurity);
        expect(operation.responses['200'].content['application/json'].schema).toEqual({
          $ref: '#/components/schemas/PharmacyOrderQueueResponse',
        });
      }
      const dispensable = spec.paths[`${prefix}/orders/{id}/dispensable`].get;
      expect(dispensable.parameters).toEqual(expect.arrayContaining([positiveOrderId]));
      expect(dispensable.responses['200'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacyOrderDispensableContextResponse',
      });
      const assignedDeliveries = spec.paths[`${prefix}/orders/assigned`].get;
      expect(assignedDeliveries.security).toEqual(authenticatedSecurity);
      expect(assignedDeliveries.parameters).not.toEqual(expect.arrayContaining([
        positiveOrderId,
      ]));
      expect(assignedDeliveries.responses['200'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacyAssignedDeliveryResponse',
      });

      for (const [suffix, [requestName, responseName]] of Object.entries(lifecycle)) {
        const operation = spec.paths[`${prefix}${suffix}`].post;
        expect(operation.security).toEqual(authenticatedSecurity);
        expect(operation.parameters).toEqual(expect.arrayContaining([positiveOrderId]));
        expect(operation.requestBody.content['application/json'].schema).toEqual({
          $ref: `#/components/schemas/${requestName}`,
        });
        expect(operation.responses['200'].content['application/json'].schema).toEqual({
          $ref: `#/components/schemas/${responseName}`,
        });
        expect(operation.responses['409'].content['application/json'].schema).toEqual({
          $ref: '#/components/schemas/PharmacyOrderDispenseErrorResponse',
        });
      }
      const preparing = spec.paths[`${prefix}/orders/{id}/preparing`].post;
      expect(preparing.parameters).toEqual(expect.arrayContaining([positiveOrderId]));
      expect(preparing.security).toEqual(authenticatedSecurity);
      for (const suffix of [
        '/orders/{id}/confirm',
        '/orders/{id}/verify',
        '/orders/{id}/preparing',
        '/orders/{id}/dispatch',
        '/orders/{id}/delivered',
        '/orders/{id}/delivery-handoff/reissue',
        '/orders/{id}/delivery-return/request',
        '/orders/{id}/delivery-return/complete',
        '/orders/{id}/dispense-counter',
        '/orders/{id}/dispense',
        '/orders/{id}/assign-facility',
        '/orders/{id}/resolve-line-identities',
        '/orders/{id}/unavailable',
        '/orders/{id}/cancel',
      ]) {
        expect(spec.paths[`${prefix}${suffix}`].post.parameters)
          .toEqual(expect.arrayContaining([idempotencyHeader]));
      }
      expect(spec.paths[`${prefix}/orders/{orderId}/status`]).toBeUndefined();
      for (const suffix of [
        '/dispense-substitution',
        '/dispense-substitution/witness-approvals',
        '/dispense-substitution/witness-approvals/{id}/approve',
      ]) {
        expect(spec.paths[`${prefix}${suffix}`].post.parameters)
          .toEqual(expect.arrayContaining([idempotencyHeader]));
      }
    }

    for (const suffix of ['order-pharmacy', 'refill']) {
      const operation = spec.paths[`/api/v1/prescriptions/{id}/${suffix}`].post;
      expect(operation.security).toEqual(authenticatedSecurity);
      expect(operation.parameters).toEqual(expect.arrayContaining([
        positiveOrderId,
        idempotencyHeader,
      ]));
      expect(operation.requestBody.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacyPrescriptionOrderRequest',
      });
      expect(operation.responses['200'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacyPrescriptionOrderResponse',
      });
    }

    for (const prefix of ['/api/v1/admin/pharmacy-supply', '/api/v1/pharmacy-supply']) {
      const movement = spec.paths[`${prefix}/stock-movements`].post;
      expect(movement.parameters).toEqual(expect.arrayContaining([idempotencyHeader]));
      expect(movement.responses['201'].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacySupplyStockMovementResponse',
      });
      const qc = spec.paths[`${prefix}/goods-receipts/{id}/items/{itemId}/qc`].patch;
      expect(qc.requestBody.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacySupplyGoodsReceiptLineQcRequest',
      });
      const transition = spec.paths[`${prefix}/goods-receipts/{id}/transition`].patch;
      expect(transition.requestBody.content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/PharmacySupplyGoodsReceiptTransitionRequest',
      });
    }
    expect(Object.keys(pharmacy.operations).filter((key) => key.endsWith('/reserve-stock')))
      .toEqual([]);
    expect(Object.keys(pharmacy.schemas).filter((key) => /^PharmacySupplyReservation/.test(key)))
      .toEqual([]);
    const positiveSupplyMovements = ['receive', 'transfer_in', 'return', 'adjust_increase'];
    expect(pharmacy.schemas.PharmacySupplyStockMovementRequest.properties.movement_kind.enum)
      .toEqual(positiveSupplyMovements);
    expect(pharmacy.schemas.PharmacySupplyStockMovementRequest.properties.quantity_delta)
      .toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true });
    expect(pharmacy.schemas.PharmacySupplyStockMovementResult.properties.movement_kind.enum)
      .toEqual(positiveSupplyMovements);
    expect(pharmacy.schemas.PharmacySupplyStockMovementResult.properties.quantity_delta)
      .toEqual({ type: 'number', minimum: 0, exclusiveMinimum: true });
    expect(pharmacy.schemas.PharmacySupplyGoodsReceiptLineQcRequest.properties.qc_status.enum)
      .toEqual(['passed', 'failed']);
    expect(pharmacy.schemas.PharmacySupplyGoodsReceiptTransitionRequest.properties.action.enum)
      .toEqual(['reject', 'finalize', 'close', 'archive']);
  });

  it('documents notification-authority validation as a bearer-authenticated fail-closed request', () => {
    const operation = spec.paths['/api/v1/devices/notification-authority/validate'].post;

    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(operation.requestBody).toEqual({
      required: true,
      content: {
        'application/json': {
          schema: {
            $ref: '#/components/schemas/NotificationAuthorityValidationRequest',
          },
        },
      },
    });
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/NotificationAuthorityValidationResponse',
    });
    expect(Object.keys(operation.responses)).toEqual([
      '200', '400', '401', '403', '429', '503',
    ]);
    for (const status of ['400', '401', '403', '429', '503']) {
      expect(operation.responses[status].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/NotificationAuthorityErrorResponse',
      });
    }
  });

  it('keeps Code Blue hydration opaque until bearer-bound authority is revalidated', () => {
    const operation = spec.paths['/api/v1/devices/notification-authority/code-blue'].post;

    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CodeBlueNotificationContentRequest',
    });
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/CodeBlueNotificationContentResponse',
    });
    expect(Object.keys(operation.responses)).toEqual(['200', '401', '403', '429', '503']);
  });

  it('documents the patient wearable correction boundary and idempotency failures', () => {
    const operation = spec.paths[
      '/api/v1/health/patient/vitals/wearable/{sourceRecordId}'
    ].put;

    expect(operation.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(operation.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'sourceRecordId', in: 'path', required: true }),
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WearableVitalCorrectionRequest',
    });
    expect(operation.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/WearableVitalCorrectionResponse',
    });
    expect(Object.keys(operation.responses)).toEqual([
      '200', '400', '401', '403', '404', '409', '422', '429', '500', '503',
    ]);
  });

  it('documents authenticated payment operations and keeps the provider webhook public', () => {
    const authenticated = [{ ApiKeyAuth: [], BearerAuth: [] }];
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (!path.startsWith('/api/v1/billing/gateway/')) continue;
      for (const operation of Object.values(methods)) {
        expect(operation.security).toEqual(authenticated);
      }
    }
    expect(spec.paths['/webhooks/payments/{webhookToken}'].post.security).toEqual([]);
  });

  it('documents refund rail separation and retry-safe webhook failures exactly', () => {
    const manualPay = spec.paths['/api/v1/billing/v2/refunds/{id}/pay'].post;
    expect(manualPay.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(manualPay.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
    ]));
    expect(spec.components.schemas.MarkRefundPaidRequest.additionalProperties).toBe(false);
    expect(spec.components.schemas.MarkRefundPaidRequest.properties).not.toHaveProperty('payout_rail');
    expect(spec.components.schemas.MarkRefundPaidRequest.properties).not.toHaveProperty('gateway_refund_id');
    expect(Object.keys(manualPay.responses)).toEqual([
      '200', '400', '401', '403', '404', '409', '422', '500', '503',
    ]);

    const webhook = spec.paths['/webhooks/payments/{webhookToken}'].post;
    expect(Object.keys(webhook.responses)).toEqual(['200', '400', '401', '404', '500', '503']);
    expect(webhook.responses['500'].description).toMatch(/provider must retry/i);
    expect(webhook.responses['503'].description).toMatch(/provider must retry/i);
  });

  it('documents tenant-bound gateway-order reconciliation evidence and failures', () => {
    const order = spec.components.schemas.PaymentGatewayOrder;
    expect(order.properties.reconciled_by).toEqual(expect.objectContaining({
      type: 'string', format: 'uuid', nullable: true,
    }));
    const reconcile = spec.paths['/api/v1/billing/gateway/orders/{id}/reconcile'].post;
    expect(reconcile.security).toEqual([{ ApiKeyAuth: [], BearerAuth: [] }]);
    expect(Object.keys(reconcile.responses)).toEqual([
      '200', '400', '401', '403', '404', '409', '500',
    ]);
  });

  it('publishes the existing HL7 receive path as a typed JSON request with raw ACK responses', () => {
    const operation = spec.paths['/api/v1/hl7/receive'].post;
    expect(operation.requestBody.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/Hl7InboundReceiveRequest',
    });
    expect(Object.keys(operation.responses).sort()).toEqual([
      '200', '400', '401', '403', '404', '409', '413', '429', '500', '503',
    ]);

    for (const status of [
      '200', '400', '401', '403', '404', '409', '429', '500', '503',
    ]) {
      expect(operation.responses[status].content['application/hl7-v2'].schema).toEqual({
        $ref: '#/components/schemas/Hl7V2Ack',
      });
    }
    for (const status of ['400', '401', '413', '429', '500']) {
      expect(operation.responses[status].content['application/json'].schema).toEqual({
        $ref: '#/components/schemas/Hl7LegacyJsonError',
      });
    }
    for (const status of ['200', '403', '404', '409', '503']) {
      expect(operation.responses[status].content['application/json']).toBeUndefined();
    }
    expect(operation.responses['413'].content['application/hl7-v2']).toBeUndefined();
    expect(operation.responses['404'].description).toMatch(/Legacy live branch only/);
    expect(operation.description).toMatch(/DB-backed HL7 credential/);
    expect(operation.description).toMatch(/downgrade fence/);
    expect(operation.description).toMatch(/exact stored ACK bytes/);
    expect(operation.description).toMatch(/never directly creates/);

    const parameters = Object.fromEntries(
      operation.parameters.map(parameter => [parameter.name, parameter]),
    );
    expect(parameters['X-HL7-Message-Id'].required).toBe(false);
    expect(parameters['X-HL7-Message-Id'].description).toMatch(/Mandatory for recovery/);
    expect(parameters['X-HL7-Timestamp'].required).toBe(true);
    expect(parameters['X-HL7-Signature'].required).toBe(true);
  });

  it('keeps legacy HL7 input compatible and closes the exact I03 recovery shape', () => {
    const schemas = spec.components.schemas;
    expect(schemas.Hl7InboundReceiveRequest.allOf).toEqual([{
      oneOf: [
        { $ref: '#/components/schemas/Hl7InboundLiveRequest' },
        { $ref: '#/components/schemas/Hl7InboundRecoveryRequest' },
      ],
    }]);
    expect(schemas.Hl7InboundReceiveRequest).toEqual(expect.objectContaining({
      type: 'object',
      required: ['message'],
      properties: {
        message: expect.objectContaining({
          type: 'string',
          maxLength: 2_000_000,
          'x-vhhealth-maxUtf8Bytes': 2_000_000,
        }),
        recovery: { $ref: '#/components/schemas/Hl7I03RecoveryEnvelope' },
      },
    }));
    expect(schemas.Hl7InboundLiveRequest).toEqual(expect.objectContaining({
      additionalProperties: true,
      required: ['message'],
      not: { required: ['recovery'] },
    }));
    expect(schemas.Hl7InboundLiveRequest.properties.message).toEqual(expect.objectContaining({
      maxLength: 1_048_576,
      'x-vhhealth-maxRequestBytes': 1_048_576,
    }));
    expect(schemas.Hl7InboundLiveRequest.properties.message.description).toMatch(
      /does not widen this branch/,
    );
    expect(schemas.Hl7InboundRecoveryRequest).toEqual(expect.objectContaining({
      additionalProperties: false,
      required: ['message', 'recovery'],
    }));
    expect(Object.keys(schemas.Hl7InboundRecoveryRequest.properties).sort()).toEqual([
      'message', 'recovery',
    ]);
    expect(schemas.Hl7InboundRecoveryRequest.properties.recovery).toEqual({
      $ref: '#/components/schemas/Hl7I03RecoveryEnvelope',
    });
    expect(schemas.Hl7InboundRecoveryRequest.properties.message).toEqual(expect.objectContaining({
      maxLength: 2_000_000,
      'x-vhhealth-maxUtf8Bytes': 2_000_000,
    }));
    expect(schemas.Hl7InboundRecoveryRequest.properties.message.description).toMatch(
      /Runtime enforcement measures the UTF-8 bytes/,
    );

    const recoveryFields = [
      'schema',
      'interface_family',
      'arrival_class',
      'tenant_id',
      'signing_credential_id',
      'offset_id',
      'source_partition',
      'generation',
      'source_position',
      'source_token',
      'predecessor_token',
      'duplicate_key',
      'message_family',
      'message_type',
      'trigger_event',
      'message_control_id',
      'message_sha256',
      'source_observed_at',
      'source_received_at',
      'clock_evidence',
    ];
    expect(schemas.Hl7I03RecoveryEnvelope.additionalProperties).toBe(false);
    expect(schemas.Hl7I03RecoveryEnvelope.required).toEqual(recoveryFields);
    expect(Object.keys(schemas.Hl7I03RecoveryEnvelope.properties)).toEqual(recoveryFields);
    expect(schemas.Hl7I03RecoveryEnvelope.properties.effect_disposition).toBeUndefined();
    expect(schemas.Hl7I03RecoveryEnvelope.properties.clock_evidence).toEqual({
      $ref: '#/components/schemas/Hl7I03ClockEvidence',
    });
    expect(schemas.Hl7I03RecoveryEnvelope.properties.signing_credential_id)
      .toEqual(expect.objectContaining({
        type: 'string',
        pattern: '^[1-9][0-9]*$',
        maxLength: 10,
        'x-vhhealth-maximumDecimal': '2147483647',
      }));
    expect(schemas.Hl7I03RecoveryEnvelope.properties.source_position)
      .toEqual(expect.objectContaining({
        type: 'string',
        pattern: '^(0|[1-9][0-9]*)$',
        maxLength: 19,
        'x-vhhealth-maximumDecimal': '9223372036854775807',
      }));
    expect(schemas.Hl7I03RecoveryEnvelope.properties.source_partition.maxLength).toBe(160);
    expect(schemas.Hl7I03RecoveryEnvelope.properties.message_control_id.maxLength).toBe(199);

    const clock = schemas.Hl7I03ClockEvidence;
    expect(clock.additionalProperties).toBe(false);
    expect(clock.required).toEqual([
      'source_clock_id', 'synchronized_at', 'maximum_error_ms',
    ]);
    expect(Object.keys(clock.properties)).toEqual(clock.required);
  });

  it('validates live compatibility and I03 family/trigger restrictions through ajv', () => {
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addSchema(ajvReadySpec(spec), 'openapi.json');
    const validate = ajv.getSchema(
      'openapi.json#/components/schemas/Hl7InboundReceiveRequest',
    );

    const message = 'MSH|^~\\&|SENDER|SITE|VH|TENANT|20260806120000+0530||ADT^A01|MSG-1|P|2.5';
    const recovery = {
      schema: 'vhhealth.i03.adt-orm-sequence/v1',
      interface_family: 'I03',
      arrival_class: 'recovery_backlog',
      tenant_id: '00000000-0000-4000-8000-000000000001',
      signing_credential_id: '7',
      offset_id: '00000000-0000-4000-8000-000000000002',
      source_partition: 'i03/credential/7/family/adt',
      generation: 1,
      source_position: '1',
      source_token: 'a'.repeat(64),
      predecessor_token: 'b'.repeat(64),
      duplicate_key: 'c'.repeat(64),
      message_family: 'adt',
      message_type: 'ADT',
      trigger_event: 'A01',
      message_control_id: 'MSG-1',
      message_sha256: 'd'.repeat(64),
      source_observed_at: '2026-08-06T12:00:00+05:30',
      source_received_at: '2026-08-06T12:00:01+05:30',
      clock_evidence: {
        source_clock_id: 'sender-ntp-1',
        synchronized_at: '2026-08-06T11:59:30+05:30',
        maximum_error_ms: 1000,
      },
    };

    expect(validate({ message, legacy_extension: 'preserved' })).toBe(true);
    expect(validate({ message, recovery })).toBe(true);

    const orm = {
      ...recovery,
      source_partition: 'i03/credential/7/family/orm',
      message_family: 'orm',
      message_type: 'ORM',
      trigger_event: 'O01',
    };
    expect(validate({ message, recovery: orm })).toBe(true);
    expect(validate({ message, recovery: null })).toBe(false);
    expect(validate({ message, recovery, unexpected: true })).toBe(false);
    expect(validate({ message, recovery: { ...recovery, unexpected: true } })).toBe(false);
    expect(validate({
      message,
      recovery: {
        ...recovery,
        clock_evidence: { ...recovery.clock_evidence, source: 'unsupported' },
      },
    })).toBe(false);
    expect(validate({ message, recovery: { ...recovery, effect_disposition: 'late_pending_only' } }))
      .toBe(false);
    expect(validate({ message, recovery: { ...recovery, signing_credential_id: 7 } })).toBe(false);
    expect(validate({ message, recovery: { ...recovery, source_position: 1 } })).toBe(false);
    expect(validate({ message, recovery: { ...recovery, message_sha256: 'D'.repeat(64) } }))
      .toBe(false);
    expect(validate({
      message,
      recovery: {
        ...recovery,
        source_observed_at: '2026-08-06T12:00:00',
      },
    })).toBe(false);
    expect(validate({
      message,
      recovery: {
        ...recovery,
        source_observed_at: '2026-08-06T12:00:00.1234567+05:30',
      },
    })).toBe(false);
    for (const invalidRecovery of [
      { ...recovery, source_observed_at: '2026-08-06T12:00:00-00:00' },
      { ...recovery, source_received_at: '2026-08-06T12:00:01-00:00' },
      {
        ...recovery,
        clock_evidence: {
          ...recovery.clock_evidence,
          synchronized_at: '2026-08-06T11:59:30-00:00',
        },
      },
    ]) {
      expect(validate({ message, recovery: invalidRecovery })).toBe(false);
    }
    expect(validate({
      message,
      recovery: {
        ...recovery,
        clock_evidence: { ...recovery.clock_evidence, maximum_error_ms: 300_001 },
      },
    })).toBe(false);
    expect(validate({
      message,
      recovery: { ...recovery, message_type: 'ORM', trigger_event: 'O01' },
    })).toBe(false);
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

  it('publishes explicit ABDM, UHI, SMS, and facility authentication and response contracts', () => {
    const bearerSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];
    const abdmCallbacks = [
      '/api/v1/abdm/consent/on-notify',
      '/api/v1/abdm/health-info/on-request',
      '/api/v1/abdm/patients/profile/share',
      '/api/v1/abdm/hiu/consent-requests/on-init',
      '/api/v1/abdm/hiu/consents/notify',
      '/api/v1/abdm/hiu/health-info/on-request',
      '/api/v1/abdm/hiu/health-info/push',
    ];
    const uhiCallbacks = [
      '/api/v1/uhi/search',
      '/api/v1/uhi/init',
      '/api/v1/uhi/confirm',
      '/api/v1/uhi/status',
      '/api/v1/uhi/cancel',
    ];
    for (const path of [...abdmCallbacks, ...uhiCallbacks]) {
      expect(spec.paths[path].post.security).toEqual([]);
    }
    for (const path of abdmCallbacks) {
      expect(spec.paths[path].post.responses['202']).toBeDefined();
      for (const status of ['400', '401', '409', '429', '500', '503']) {
        expect(spec.paths[path].post.responses[status]).toBeDefined();
      }
      const parameters = spec.paths[path].post.parameters;
      expect(parameters.map(parameter => parameter.name)).toEqual(expect.arrayContaining([
        'x-hip-id',
        'x-abdm-signature-version',
        'x-abdm-signature',
        'timestamp',
        'request-id',
      ]));
      expect(parameters.find(parameter => parameter.name === 'x-abdm-signature-version'))
        .toMatchObject({ required: true, schema: { type: 'string', enum: ['v1'] } });
      expect(spec.paths[path].post.description).toMatch(/canonical application path/i);
    }
    for (const path of uhiCallbacks) {
      expect(spec.paths[path].post.responses['200']).toBeDefined();
      for (const status of ['400', '401', '404', '429', '500']) {
        expect(spec.paths[path].post.responses[status]).toBeDefined();
      }
      expect(spec.paths[path].post.responses['409']).toBeUndefined();
    }

    const uhiConfirm = spec.paths['/api/v1/uhi/confirm'].post;
    expect(uhiConfirm.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/UhiAckResponse');
    expect(uhiConfirm.description).toMatch(/transport-ACKed with HTTP 200.*business NACK/s);
    expect(spec.components.schemas.UhiNackResponse.required).toEqual(['message', 'error']);
    expect(spec.components.schemas.UhiNackResponse.properties).not.toHaveProperty('success');
    expect(uhiConfirm.responses['400'].content['application/json'].schema.oneOf)
      .toEqual(expect.arrayContaining([
        { $ref: '#/components/schemas/UhiErrorResponse' },
        { $ref: '#/components/schemas/UhiNackResponse' },
      ]));

    const uhiContext = spec.components.schemas.UhiContext;
    expect(uhiContext.required).toEqual(expect.arrayContaining([
      'action', 'bpp_id', 'bap_id', 'bap_uri',
    ]));
    for (const field of ['action', 'bpp_id', 'bap_id', 'bap_uri']) {
      expect(uhiContext.properties[field]).not.toHaveProperty('nullable', true);
    }
    expect(uhiContext.properties.action.enum).toEqual(
      expect.arrayContaining(['search', 'init', 'confirm', 'status', 'cancel']),
    );

    const uhiList = spec.paths['/api/v1/admin/uhi/transactions'].get;
    expect(uhiList.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'status', in: 'query' }),
      expect.objectContaining({ name: 'action', in: 'query' }),
      expect.objectContaining({ name: 'transaction_id', in: 'query' }),
      expect.objectContaining({ name: 'limit', in: 'query' }),
      expect.objectContaining({ name: 'offset', in: 'query' }),
    ]));
    expect(spec.components.schemas.UhiTransactionListPayload.required)
      .toEqual(expect.arrayContaining(['enabled', 'transactions', 'limit', 'offset']));

    const publicOperationKeys = new Set([
      ...abdmCallbacks.map(path => `POST ${path}`),
      ...uhiCallbacks.map(path => `POST ${path}`),
      'POST /webhooks/sms/dlr/{token}',
      'POST /webhooks/sms/twilio-status/{token}',
    ]);
    for (const module of [abdmCompletion, smsConfig, facilityAssets, uhi]) {
      for (const operationKey of Object.keys(module.operations)) {
        if (publicOperationKeys.has(operationKey)) continue;
        const [method, path] = operationKey.split(' ');
        expect(spec.paths[path][method.toLowerCase()].security).toEqual(bearerSecurity);
      }
    }

    for (const path of [
      '/api/v1/portal/abdm/enrolment/start',
      '/api/v1/abdm/enrolment/start',
      '/api/v1/front-desk/abdm/share-intakes/{id}/register',
      '/api/v1/abdm/hiu/consent-requests',
      '/api/v1/abdm/hiu/consents/{artifactId}/fetch',
      '/api/v1/facility/assets',
    ]) {
      expect(spec.paths[path].post.responses['201']).toBeDefined();
    }
    const authenticatedExamples = [
      spec.paths['/api/v1/portal/abdm/enrolment/start'].post,
      spec.paths['/api/v1/admin/notifications/sms/config'].get,
      spec.paths['/api/v1/facility/assets'].get,
      spec.paths['/api/v1/admin/uhi/transactions'].get,
    ];
    for (const operation of authenticatedExamples) {
      for (const status of ['400', '401', '403', '429', '500']) {
        expect(operation.responses[status]).toBeDefined();
      }
    }

    const msg91Form = spec.components.schemas.Msg91DlrFormRequest;
    expect(msg91Form.required).toBeUndefined();
    expect(spec.components.schemas.Msg91DlrEntry.properties.requestId.oneOf)
      .toEqual(expect.arrayContaining([{ type: 'string' }, { type: 'integer' }]));
    const twilioForm = spec.components.schemas.TwilioSmsStatusFormRequest;
    expect(twilioForm.anyOf).toBeUndefined();
    expect(twilioForm.properties.MessageSid.oneOf)
      .toEqual(expect.arrayContaining([{ type: 'string' }, { type: 'integer' }]));
    const twilioErrors = spec.paths['/webhooks/sms/twilio-status/{token}'].post.responses;
    expect(twilioErrors['400']).toBeUndefined();
    expect(spec.components.schemas.SmsValidationErrorResponse.required)
      .toEqual(['success', 'errors']);
    expect(spec.paths['/api/v1/admin/notifications/sms/config'].put.responses['400']
      .content['application/json'].schema.oneOf)
      .toEqual(expect.arrayContaining([
        { $ref: '#/components/schemas/SmsDlrErrorResponse' },
        { $ref: '#/components/schemas/SmsValidationErrorResponse' },
      ]));
  });
});
