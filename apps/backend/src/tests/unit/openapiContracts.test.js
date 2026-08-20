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
    const inventoryRequest = spec.components.schemas.PharmacyInventoryWitnessApprovalRequest;
    expect(inventoryRequest.required).toEqual([
      'inventory_item_id', 'inventory_batch_id', 'quantity',
    ]);

    for (const prefix of ['/api/v1/pharmacy-orders', '/api/v1/pharmacy']) {
      const bearerSecurity = [{ ApiKeyAuth: [], BearerAuth: [] }];
      const finalSale = spec.paths[`${prefix}/counter-sales`]?.post;
      const requestApproval = spec.paths[`${prefix}/counter-sales/witness-approvals`]?.post;
      const approve = spec.paths[`${prefix}/counter-sales/witness-approvals/{id}/approve`]?.post;
      const finalDispense = spec.paths[`${prefix}/inventory/v2/controlled-dispense`]?.post;
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
          schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
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
          schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
        }),
      ]));
      for (const operation of [
        finalSale,
        requestApproval,
        approve,
        finalDispense,
        inventoryRequest,
        inventoryApprove,
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
        inventoryRequest,
        inventoryApprove,
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
      for (const operation of [inventoryRequest, inventoryApprove]) {
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
