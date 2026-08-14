// src/routes/hl7/hl7Routes.js
// HL7v2 messaging routes — HTTP bridge for MLLP-style HL7v2 message exchange.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import tenantContextMiddleware from '../../middleware/tenantContextMiddleware.js';
import tenantRlsMiddleware from '../../middleware/tenantRlsMiddleware.js';
import { requireAnyRole } from '../../middleware/rbacMiddleware.js';
import { parseHL7, generateACK } from '../../services/hl7/hl7Parser.js';
import {
  admissionToADT,
  dischargeToADT,
  orderToORM,
  resultToORU,
  parseADTToAdmission,
  parseORMToOrder,
} from '../../services/hl7/hl7Transformer.js';
import { AppError } from '../../utils/AppError.js';
import { verifySignedRequest, assertSharedReplayOnce } from '../../utils/signedRequest.js';
import { resolveInteropCredentialSnapshot } from '../../services/interop/tenantInteropSecretService.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';
import {
  assertEnvBackedHl7InboundLivePathAvailable,
  prepareHl7InboundRecoveryAuthentication,
  submitHl7InboundRecovery,
} from '../../services/integrations/externalHl7InboundRecoveryService.js';
import { processHl7InboundClinicalMessage } from '../../services/hl7/hl7InboundClinicalCommandService.js';
import {
  assertHl7InboundIngressEnabled,
  hl7InboundIngressGate,
} from './hl7InboundIngressGate.js';
import { hl7IngressLimiter } from './hl7IngressRateLimit.js';

const router = express.Router();
const HL7_EXPORT_ROLES = ['ADMIN', 'SUPER_ADMIN', 'INTEGRATION_ADMIN', 'MEDICAL_RECORDS'];
const PERMANENT_HL7_CLINICAL_REJECTION_CODES = new Set([
  'HL7_CLINICAL_RECEIPT_IDENTITY_DRIFT',
  'HL7_CLINICAL_PATIENT_INVALID',
  'HL7_ADMISSION_VISIT_REQUIRED',
  'HL7_ADMISSION_VISIT_ALREADY_EXISTS',
  'HL7_ADMISSION_VISIT_UNKNOWN',
  'HL7_ADMISSION_VISIT_AMBIGUOUS',
  'HL7_ADMISSION_VISIT_PATIENT_MISMATCH',
  'HL7_ADMISSION_VISIT_NOT_ACTIVE',
  'HL7_ADMISSION_VISIT_TARGET_CHANGED',
]);

function assertLocalInvestigationExportContract(investigation, { requireResults = false } = {}) {
  const orderedTestCode = String(investigation?.test_code || '').trim();
  const results = Array.isArray(investigation?.results) ? investigation.results : [];
  const resultsMatch = !requireResults || (
    results.length > 0
    && results.every((result) => {
      if (!result || typeof result !== 'object') return false;
      const identity = String(
        result.test_code || result.code || result.observation_id || '',
      ).trim();
      return identity.split('^', 1)[0].trim() === orderedTestCode;
    })
  );
  if (!orderedTestCode || !resultsMatch) {
    throw AppError.badRequest(
      'Investigation does not have a machine-verifiable HL7 analyte contract',
      'HL7_LOCAL_ORDER_ANALYTE_CONTRACT_REQUIRED',
    );
  }
}

// Preserve the legacy router-level generic limiter and its authenticated
// tenant/API-key bucket. Recovery requests keep that same limiter; only their
// wire-format rejection is converted to an HL7 ACK.
//
// hl7IngressLimiter enforces it AT MOST ONCE per request. Under the production
// composition (mountHl7Interface) every HL7 request has already met this exact
// limiter one mount earlier — at the same relative path, in the same chain
// position, on the same bucket — because it has to run AHEAD of the ingress
// gate, which short-circuits before this router. So this is a pass-through
// there, and the enforcing layer for any other mount of this router.
router.use(hl7IngressLimiter);

// HL7_INBOUND_ENABLED gate, second layer. The first layer sits at the app.js
// mount, behind that same limiter; this one keeps the router itself fail-closed
// if it is ever mounted somewhere else. It is registered AFTER the limiter
// above on purpose, so a disabled interface is still rate limited on such a
// mount rather than becoming a free request sink, and BEFORE every /receive
// handler, so no credential is resolved and no database read is issued while
// the interface is off.
router.use('/receive', hl7InboundIngressGate);

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function assertHl7InboundAuthentic(req, {
  message,
  controlId,
  receivingFacility,
  recoveryAuthentication = null,
}) {
  // HL7_INBOUND_ENABLED gate, third and innermost layer. Placed ahead of every
  // credential lookup so the answer to "can this credential authenticate an
  // inbound message?" is NO while the interface is declared off — for the
  // DB-backed tenant_interop_secrets row and the legacy shared secret alike,
  // and for the live and recovery paths alike. Routing can be changed; this
  // cannot be routed around.
  assertHl7InboundIngressEnabled();
  const explicitRecoveryRequestId = String(req.headers['x-hl7-message-id'] || '').trim();
  if (recoveryAuthentication && !explicitRecoveryRequestId) {
    throw AppError.unauthorized(
      'HL7 recovery request id is required',
      'HL7_I03_RECOVERY_REQUEST_ID_REQUIRED',
    );
  }
  if (
    recoveryAuthentication
    && (
      explicitRecoveryRequestId.length > 200
      || [...explicitRecoveryRequestId].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
      })
    )
  ) {
    throw AppError.unauthorized(
      'HL7 recovery request id is invalid',
      'HL7_I03_RECOVERY_REQUEST_ID_INVALID',
    );
  }
  const requestId = recoveryAuthentication
    ? explicitRecoveryRequestId
    : req.headers['x-hl7-message-id'] || req.headers['x-request-id'] || controlId;
  const signature = req.headers['x-hl7-signature'] || req.headers['x-vhhealth-hl7-signature'];
  const timestamp = req.headers['x-hl7-timestamp'] || req.headers.timestamp;

  // W3: resolve the destination tenant from the MSH-6 receiving facility BEFORE
  // the HMAC check, then verify with THAT tenant's secret — so one hospital's
  // secret cannot authenticate a message aimed at another. (Sending facility is
  // many-to-one to a hospital; the RECEIVING facility identifies the tenant.)
  // A per-tenant row (tenant_interop_secrets) wins. Legacy single-tenant: with
  // HL7_RECEIVING_FACILITY unset, the global secret backs the default tenant for
  // any receiver (unchanged); once it is set, the facility must match. An
  // unrecognized receiver with no usable secret is rejected.
  let credentialSnapshot = null;
  let tenantId;
  let secret;
  if (recoveryAuthentication) {
    credentialSnapshot = await resolveInteropCredentialSnapshot(
      'hl7_inbound',
      receivingFacility,
    );
    if (!credentialSnapshot) {
      throw AppError.unauthorized(
        'HL7 recovery requires an active DB-backed credential',
        'HL7_I03_RECOVERY_CREDENTIAL_REQUIRED',
      );
    }
    tenantId = credentialSnapshot.tenant_id;
    secret = credentialSnapshot.secret;
  } else {
    credentialSnapshot = await resolveInteropCredentialSnapshot(
      'hl7_inbound',
      receivingFacility,
    );
    tenantId = credentialSnapshot?.tenant_id;
    secret = credentialSnapshot?.secret;
  }
  // CAN-021: a per-tenant inbound secret authenticates a SPECIFIC tenant's feed,
  // so the named patient MUST belong to that tenant (strict). The shared-secret
  // fallback is the legacy single-tenant/default path (not strict) and is now
  // confined to DEFAULT-tenant patients — see loadHl7Patient and
  // hl7-receive-tenant-binding.
  let strictTenant = !!(tenantId && secret);
  if (!recoveryAuthentication && !secret && process.env.HL7_INBOUND_SHARED_SECRET) {
    const configuredFacility = String(process.env.HL7_RECEIVING_FACILITY || '').trim();
    if (!configuredFacility || String(receivingFacility || '').trim() === configuredFacility) {
      tenantId = DEFAULT_TENANT_ID;
      secret = process.env.HL7_INBOUND_SHARED_SECRET;
      strictTenant = false;
    }
  }
  if (!tenantId || !secret) {
    throw AppError.unauthorized('HL7 inbound sender not recognized', 'HL7_INBOUND_SENDER_UNKNOWN');
  }
  const authenticatedSenderIdentity = credentialSnapshot
    ? `hl7-inbound-credential:${credentialSnapshot.id}`
    : 'hl7-inbound-credential:legacy-env';

  // Sync fast-path: HMAC + freshness + same-process replay.
  const signedRequest = {
    secret,
    signature,
    timestamp,
    requestId,
    payload: recoveryAuthentication?.signedPayload || message,
    context: 'HL7 inbound message',
    codePrefix: 'HL7_INBOUND',
    replayNamespace: 'hl7-inbound',
  };
  verifySignedRequest({ ...signedRequest, claimLocalReplay: false });
  if (
    recoveryAuthentication
    && (
      String(credentialSnapshot.id) !== recoveryAuthentication.signingCredentialId
      || String(credentialSnapshot.tenant_id).toLowerCase() !== recoveryAuthentication.tenantId
    )
  ) {
    throw AppError.unauthorized(
      'HL7 recovery credentials do not match the signed recovery envelope',
      'HL7_I03_RECOVERY_CREDENTIAL_MISMATCH',
    );
  }
  // A DB-backed API key is tenant-owned. This router is mounted before the
  // global JWT/tenant middleware, so enforce the same credential equality
  // here after HMAC verification (no tenant oracle) but before consuming the
  // durable replay key.
  if (
    req.apiClientTenantId
    && String(req.apiClientTenantId).toLowerCase() !== String(tenantId).toLowerCase()
  ) {
    throw AppError.unauthorized(
      'HL7 inbound credentials do not match the destination',
      'HL7_INBOUND_CREDENTIAL_MISMATCH',
    );
  }
  // Claim the process-local replay cache only after every authenticated tenant
  // signal agrees. Re-verification preserves the helper's invariant that it
  // never exposes an unverified replay-claim primitive.
  verifySignedRequest(signedRequest);
  // Cross-replica replay guard (the per-process Map above is defeated by the
  // multi-worker / multi-replica cluster).
  await assertSharedReplayOnce({
    replayNamespace: 'hl7-inbound',
    requestId,
    timestamp,
    signature,
    context: 'HL7 inbound message',
    codePrefix: 'HL7_INBOUND',
  });
  req.tenantId = tenantId; // the authenticated destination tenant
  req.hl7StrictTenant = strictTenant; // CAN-021: enforce patient-tenant match on the per-tenant-secret path
  req.hl7CredentialSnapshot = credentialSnapshot;
  req.hl7AuthenticatedSenderIdentity = authenticatedSenderIdentity;
}

function i03MessageFamily(messageType) {
  if (['ADT^A01', 'ADT^A02', 'ADT^A03'].includes(messageType)) return 'adt';
  if (messageType === 'ORM^O01') return 'orm';
  return null;
}

function sendHl7Ack(res, status, controlId, code, text) {
  res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
  return res.status(status).send(generateACK(controlId || 'UNKNOWN', code, text));
}

export function hl7AuthenticityAckCode(error, { recovery = false } = {}) {
  return recovery && Number(error?.statusCode) >= 500 ? 'AE' : 'AR';
}

export function hl7ClinicalAckCode(error) {
  return PERMANENT_HL7_CLINICAL_REJECTION_CODES.has(error?.code) ? 'AR' : 'AE';
}

// Resolve the patient by uid GLOBALLY (the sender's tenant is not in the
// message; the patient uid is the only identifier). This read intentionally
// runs on plain prisma so it can find the patient in whichever tenant they
// belong to — but EVERY subsequent write is then scoped to that patient's
// tenant via the canonical inbound command, so a non-default patient's clinical
// rows can never be stamped into the default (or any other) tenant. Returns null
// if not found.
async function loadHl7Patient(patientUid, authenticatedTenantId, strictTenant) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id::text AS tenant_id, phone
       FROM users
      WHERE uid = $1::uuid
        AND is_active = true
        AND UPPER(BTRIM(COALESCE(role::text, ''))) = 'PATIENT'
      LIMIT 1`,
    patientUid,
  );
  const row = rows[0] || null;
  // A patient with no tenant_id cannot be safely scoped — refuse rather than
  // fall back to the default tenant for a non-default patient.
  if (row && !row.tenant_id) return null;
  // CAN-021: on the per-tenant-secret path, a tenant-A feed must not write to a
  // tenant-B patient. Refuse the mismatch (handler returns the same "not
  // registered at this facility" AE as an unknown patient).
  if (strictTenant && row && String(row.tenant_id) !== String(authenticatedTenantId)) return null;
  // Guard-now / retire-later (2026-08-06): the HL7_INBOUND_SHARED_SECRET
  // fallback (non-strict) is ONE env-wide credential, so it may only vouch for
  // the legacy single-tenant (DEFAULT) population. It used to authenticate
  // messages for ANY tenant's patients (writes landed in the patient's own
  // tenant); now a patient in any other tenant must arrive via that tenant's
  // per-tenant inbound secret. Refuse here — before any write — with the same
  // "not registered" AE as an unknown patient (no tenant oracle). Retiring the
  // shared-secret fallback entirely is the follow-up.
  if (!strictTenant && row && String(row.tenant_id) !== String(DEFAULT_TENANT_ID)) return null;
  return row;
}

// ---------------------------------------------------------------------------
// POST /receive — Receive an HL7v2 message (HTTP bridge for MLLP)
// Parses message type, routes to appropriate handler, returns HL7 ACK.
// ---------------------------------------------------------------------------
router.post(
  '/receive',
  wrapAsync(async (req, res) => {
    const body = req.body;
    const hasRecovery = Boolean(
      body
      && typeof body === 'object'
      && Object.prototype.hasOwnProperty.call(body, 'recovery'),
    );
    const message = body?.message;
    let recoveryAuthentication = null;
    let parsed;

    if (hasRecovery) {
      try {
        recoveryAuthentication = prepareHl7InboundRecoveryAuthentication({ body });
        parsed = recoveryAuthentication.parsed;
      } catch (err) {
        logger.warn('HL7 I03 recovery contract rejected', {
          interfaceFamily: 'I03',
          code: err?.code,
        });
        return sendHl7Ack(res, err?.statusCode || 400, 'UNKNOWN', 'AR', 'Recovery request rejected');
      }
    } else if (!message || typeof message !== 'string') {
      throw AppError.badRequest('Request body must include a "message" string containing the HL7v2 message');
    }

    if (!parsed) {
      try {
        parsed = parseHL7(message);
      } catch (err) {
        logger.error('HL7 parse error', { error: err.message, requestId: req.id });
        return sendHl7Ack(res, 400, 'UNKNOWN', 'AR', 'Parse error: Invalid HL7 message format');
      }
    }

    if (!parsed.msh) {
      return sendHl7Ack(res, 400, 'UNKNOWN', 'AR', 'Missing MSH segment');
    }

    const messageType = parsed.msh.messageType || '';
    const controlId = parsed.msh.messageControlId || '';

    try {
      await assertHl7InboundAuthentic(req, {
        message,
        controlId,
        receivingFacility: parsed.msh?.receivingFacility,
        recoveryAuthentication,
      });
    } catch (err) {
      logger.warn('HL7 inbound message rejected by authenticity check', {
        messageType,
        ...(hasRecovery ? { interfaceFamily: 'I03' } : { controlId, requestId: req.id }),
        code: err.code,
      });
      return sendHl7Ack(
        res,
        err.statusCode || 401,
        controlId,
        hl7AuthenticityAckCode(err, { recovery: hasRecovery }),
        hasRecovery ? 'Recovery request rejected' : (err.message || 'HL7 message authentication failed'),
      );
    }

    if (hasRecovery) {
      try {
        const result = await submitHl7InboundRecovery({
          message,
          recovery: recoveryAuthentication.recovery,
          parsed,
          credentialSnapshot: req.hl7CredentialSnapshot,
        });
        logger.info('HL7 I03 recovery item accepted for reconciliation', {
          interfaceFamily: 'I03',
          messageFamily: recoveryAuthentication.messageFamily,
          generation: recoveryAuthentication.generation,
          duplicate: result.duplicate,
        });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(result.httpStatus).send(result.ack);
      } catch (err) {
        logger.warn('HL7 I03 recovery item refused', {
          interfaceFamily: 'I03',
          messageFamily: recoveryAuthentication.messageFamily,
          generation: recoveryAuthentication.generation,
          code: err?.code,
        });
        const status = err?.statusCode || 500;
        const ackCode = status === 400 || status === 401 || status === 403 ? 'AR' : 'AE';
        return sendHl7Ack(res, status, controlId, ackCode, 'Recovery request rejected');
      }
    }

    const enrolledFamily = i03MessageFamily(messageType);
    if (enrolledFamily) {
      try {
        if (String(parsed.msh?.receivingFacility || '').trim()) {
          await assertEnvBackedHl7InboundLivePathAvailable({
            receivingFacility: parsed.msh?.receivingFacility,
            messageFamily: enrolledFamily,
          });
        }
      } catch (err) {
        logger.warn('HL7 live ingress blocked by I03 recovery state', {
          interfaceFamily: 'I03',
          messageFamily: enrolledFamily,
          code: err?.code,
          requestId: req.id,
        });
        return sendHl7Ack(
          res,
          err?.statusCode || 500,
          controlId,
          'AE',
          'Signed recovery envelope required',
        );
      }
    }

    logger.info('HL7 message received', {
      messageType,
      controlId,
      sendingApp: parsed.msh.sendingApp,
      requestId: req.id,
    });

    const senderIdentity = req.hl7AuthenticatedSenderIdentity;

    try {
      // Route based on message type
      if (messageType === 'ADT^A01' || messageType === 'ADT^A02' || messageType === 'ADT^A03') {
        const { admission, patient } = parseADTToAdmission(message);

        if (!patient.uid) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(400).send(generateACK(controlId, 'AE', 'Patient identifier (PID.3) is required'));
        }
        const patientRow = await loadHl7Patient(patient.uid, req.tenantId, req.hl7StrictTenant);
        if (!patientRow) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(404).send(generateACK(controlId, 'AE', 'Patient is not registered at this facility'));
        }

        const result = await processHl7InboundClinicalMessage({
          tenantId: patientRow.tenant_id,
          patientUid: patient.uid,
          patientPhone: patientRow.phone,
          senderIdentity,
          messageControlId: controlId,
          messageType,
          message,
          admission,
          requestId: req.id,
        });

        logger.info('HL7 ADT processed', {
          messageType,
          patientUid: patient.uid,
          duplicate: result.duplicate,
          requestId: req.id,
        });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(200).send(generateACK(
          controlId,
          result.receipt.acknowledgement_code,
          result.receipt.acknowledgement_text,
        ));
      }

      if (messageType === 'ORM^O01') {
        const { order, patient } = parseORMToOrder(message);

        if (!patient.uid) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(400).send(generateACK(controlId, 'AE', 'Patient identifier (PID.3) is required'));
        }
        const patientRow = await loadHl7Patient(patient.uid, req.tenantId, req.hl7StrictTenant);
        if (!patientRow) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(404).send(generateACK(controlId, 'AE', 'Patient is not registered at this facility'));
        }

        const result = await processHl7InboundClinicalMessage({
          tenantId: patientRow.tenant_id,
          patientUid: patient.uid,
          patientPhone: patientRow.phone,
          senderIdentity,
          messageControlId: controlId,
          messageType,
          message,
          order,
          requestId: req.id,
        });

        logger.info('HL7 ORM processed', {
          testName: order.test_name,
          patientUid: patient.uid,
          duplicate: result.duplicate,
          requestId: req.id,
        });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(200).send(generateACK(
          controlId,
          result.receipt.acknowledgement_code,
          result.receipt.acknowledgement_text,
        ));
      }

      if (messageType === 'ORU^R01' || messageType === 'ORU^R01^ORU_R01') {
        // The legacy HMAC-only route has no DB-grounded human/machine actor and
        // cannot satisfy the replay claim, analyzer binding, canonical result,
        // critical alert, task, and SLA contract. Never write a partial result
        // here; authenticated analyzer integrations use /api/v1/lab/oru/ingest.
        logger.warn('Legacy HL7 ORU ingestion rejected; authenticated lab ingest required', {
          controlId,
          requestId: req.id,
        });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(200).send(generateACK(
          controlId,
          'AE',
          'Use authenticated lab ORU ingestion',
        ));
      }

      // Unsupported message type
      logger.warn('HL7 unsupported message type', { messageType, requestId: req.id });
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res.status(200).send(generateACK(controlId, 'AE', `Unsupported message type: ${messageType}`));
    } catch (err) {
      logger.error('HL7 processing error', {
        messageType,
        error: err.message,
        code: err.code,
        requestId: req.id,
      });
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      const status = err?.statusCode || 500;
      const messageText = status < 500 ? 'Message rejected' : 'Internal processing error';
      return res.status(status).send(generateACK(controlId, hl7ClinicalAckCode(err), messageText));
    }
  })
);

// ---------------------------------------------------------------------------
// POST /generate — Generate an HL7v2 message for a given event
// Body: { event_type: "ADT_A01", admission_id: 123 }
//        { event_type: "ADT_A03", admission_id: 123 }
//        { event_type: "ORM_O01", investigation_id: 123 }
//        { event_type: "ORU_R01", investigation_id: 123 }
// ---------------------------------------------------------------------------
router.post(
  '/generate',
  jwtAuth,
  requireAnyRole(...HL7_EXPORT_ROLES),
  tenantContextMiddleware,
  // Tenancy hardening: this router is mounted before the global RLS
  // middleware, so seed the AsyncLocalStorage tenant context here too —
  // the prod auto-setTenant wrap then backstops the hand-written
  // tenant_id predicates below.
  tenantRlsMiddleware,
  wrapAsync(async (req, res) => {
    const { event_type, admission_id, investigation_id } = req.body;

    if (!event_type) {
      throw AppError.badRequest('event_type is required');
    }

    let hl7Message;

    if (event_type === 'ADT_A01' || event_type === 'ADT_A03') {
      if (!admission_id) {
        throw AppError.badRequest('admission_id is required for ADT events');
      }

      const admissionRows = await prisma.$queryRawUnsafe(
        `SELECT id, patient_uid, status, ward, bed_number, priority, admission_type,
                admitting_doctor, attending_doctor, admitted_at, discharged_at,
                encounter_id, reason, reason_for_admission, discharge_disposition, discharge_type
         FROM admissions WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
        admission_id,
        req.tenantId,
      );

      if (!admissionRows.length) {
        throw AppError.notFound('Admission not found');
      }

      const admission = admissionRows[0];

      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT uid, name, phone, gender, birthday, address FROM users WHERE uid = $1 AND tenant_id = $2::uuid LIMIT 1`,
        admission.patient_uid,
        req.tenantId,
      );

      const patient = patientRows[0] || { uid: admission.patient_uid };

      if (event_type === 'ADT_A01') {
        hl7Message = admissionToADT(admission, patient);
      } else {
        hl7Message = dischargeToADT(admission, patient);
      }
    } else if (event_type === 'ORM_O01' || event_type === 'ORU_R01') {
      if (!investigation_id) {
        throw AppError.badRequest('investigation_id is required for ORM/ORU events');
      }

      const investigationRows = await prisma.$queryRawUnsafe(
        `SELECT id, patient_uid, uid, test_code, test_name, investigation_type, status,
                results, conclusion, interpretation, requested_at AS ordered_at,
                completed_at, created_at
         FROM investigations WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
        investigation_id,
        req.tenantId,
      );

      if (!investigationRows.length) {
        throw AppError.notFound('Investigation not found');
      }

      const investigation = investigationRows[0];
      const patientUid = investigation.patient_uid || investigation.uid;

      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT uid, name, phone, gender, birthday, address FROM users WHERE uid = $1 AND tenant_id = $2::uuid LIMIT 1`,
        patientUid,
        req.tenantId,
      );

      const patient = patientRows[0] || { uid: patientUid };

      if (event_type === 'ORM_O01') {
        assertLocalInvestigationExportContract(investigation);
        hl7Message = orderToORM(investigation, patient, {
          enforceLocalOrderContract: true,
        });
      } else {
        assertLocalInvestigationExportContract(investigation, { requireResults: true });
        hl7Message = resultToORU(investigation, patient, {
          enforceLocalOrderContract: true,
        });
      }
    } else {
      throw AppError.badRequest(`Unsupported event_type: ${event_type}. Supported: ADT_A01, ADT_A03, ORM_O01, ORU_R01`);
    }

    res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
    res.status(200).send(hl7Message);
  })
);

// ---------------------------------------------------------------------------
// GET /capability — Returns supported message types and versions
// ---------------------------------------------------------------------------
router.get(
  '/capability',
  wrapAsync(async (req, res) => {
    const capability = {
      application: 'VH Health HL7v2 Gateway',
      version: process.env.API_VERSION || '1.0.0',
      hl7Version: '2.5',
      supportedMessages: {
        inbound: [
          {
            type: 'ADT^A01',
            description: 'Admit/Visit Notification',
            action: 'Creates admission record',
          },
          {
            type: 'ADT^A02',
            description: 'Transfer a Patient',
            action: 'Creates/updates admission record',
          },
          {
            type: 'ADT^A03',
            description: 'Discharge/End Visit',
            action: 'Updates admission to discharged',
          },
          {
            type: 'ORM^O01',
            description: 'Order Message',
            action: 'Creates investigation order',
          },
        ],
        outbound: [
          {
            type: 'ADT^A01',
            description: 'Admit/Visit Notification',
            trigger: 'event_type: ADT_A01',
          },
          {
            type: 'ADT^A03',
            description: 'Discharge/End Visit',
            trigger: 'event_type: ADT_A03',
          },
          {
            type: 'ORM^O01',
            description: 'Order Message',
            trigger: 'event_type: ORM_O01',
          },
          {
            type: 'ORU^R01',
            description: 'Observation Result',
            trigger: 'event_type: ORU_R01',
          },
        ],
      },
      segmentsSupported: ['MSH', 'PID', 'PV1', 'OBR', 'OBX', 'MSA'],
      acknowledgment: 'All inbound messages receive HL7 ACK (AA/AE/AR)',
      transport: 'HTTP (MLLP bridge)',
    };

    res.json(capability);
  })
);

export default router;
