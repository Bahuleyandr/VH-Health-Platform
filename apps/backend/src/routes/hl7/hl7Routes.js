// src/routes/hl7/hl7Routes.js
// HL7v2 messaging routes — HTTP bridge for MLLP-style HL7v2 message exchange.

import express from 'express';
import prisma, { setTenant } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
import tenantContextMiddleware from '../../middleware/tenantContextMiddleware.js';
import { genericLimiter } from '../../middleware/rateLimitMiddleware.js';
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
import { resolveTenantBySender, getInteropSecret } from '../../services/interop/tenantInteropSecretService.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';

const router = express.Router();
const HL7_EXPORT_ROLES = ['ADMIN', 'SUPER_ADMIN', 'INTEGRATION_ADMIN', 'MEDICAL_RECORDS'];

// C-4: this router is mounted BEFORE the global JWT auth + rate limiters
// (app.js), and /receive is unauthenticated (HMAC-signed only). DB work happens
// around the HMAC check, so without a limiter here it is a brute-force / DoS
// surface. Throttle every inbound HL7 request per-IP (the generic profile keys
// by IP when no JWT/api-key identity is present).
router.use(genericLimiter);

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function assertHl7InboundAuthentic(req, { message, controlId, receivingFacility }) {
  const requestId = req.headers['x-hl7-message-id'] || req.headers['x-request-id'] || controlId;
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
  let tenantId = await resolveTenantBySender('hl7_inbound', receivingFacility);
  let secret = tenantId ? await getInteropSecret(tenantId, 'hl7_inbound') : null;
  if (!secret && process.env.HL7_INBOUND_SHARED_SECRET) {
    const configuredFacility = String(process.env.HL7_RECEIVING_FACILITY || '').trim();
    if (!configuredFacility || String(receivingFacility || '').trim() === configuredFacility) {
      tenantId = DEFAULT_TENANT_ID;
      secret = process.env.HL7_INBOUND_SHARED_SECRET;
    }
  }
  if (!tenantId || !secret) {
    throw AppError.unauthorized('HL7 inbound sender not recognized', 'HL7_INBOUND_SENDER_UNKNOWN');
  }

  // Sync fast-path: HMAC + freshness + same-process replay.
  verifySignedRequest({
    secret,
    signature,
    timestamp,
    requestId,
    payload: message,
    context: 'HL7 inbound message',
    codePrefix: 'HL7_INBOUND',
    replayNamespace: 'hl7-inbound',
  });
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
}

// Resolve the patient by uid GLOBALLY (the sender's tenant is not in the
// message; the patient uid is the only identifier). This read intentionally
// runs on plain prisma so it can find the patient in whichever tenant they
// belong to — but EVERY subsequent write is then scoped to that patient's
// tenant via setTenant(), so a non-default patient's clinical rows can never be
// stamped into the default (or any other) tenant. Returns null if not found.
async function loadHl7Patient(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id::text AS tenant_id, phone FROM users WHERE uid = $1::uuid AND is_active = true LIMIT 1`,
    patientUid,
  );
  const row = rows[0] || null;
  // A patient with no tenant_id cannot be safely scoped — refuse rather than
  // fall back to the default tenant for a non-default patient.
  if (row && !row.tenant_id) return null;
  return row;
}

// ---------------------------------------------------------------------------
// POST /receive — Receive an HL7v2 message (HTTP bridge for MLLP)
// Parses message type, routes to appropriate handler, returns HL7 ACK.
// ---------------------------------------------------------------------------
router.post(
  '/receive',
  wrapAsync(async (req, res) => {
    const { message } = req.body;

    if (!message || typeof message !== 'string') {
      throw AppError.badRequest('Request body must include a "message" string containing the HL7v2 message');
    }

    let parsed;
    try {
      parsed = parseHL7(message);
    } catch (err) {
      logger.error('HL7 parse error', { error: err.message, requestId: req.id });
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res.status(400).send(generateACK('UNKNOWN', 'AR', 'Parse error: Invalid HL7 message format'));
    }

    if (!parsed.msh) {
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res.status(400).send(generateACK('UNKNOWN', 'AR', 'Missing MSH segment'));
    }

    const messageType = parsed.msh.messageType || '';
    const controlId = parsed.msh.messageControlId || '';

    try {
      await assertHl7InboundAuthentic(req, { message, controlId, receivingFacility: parsed.msh?.receivingFacility });
    } catch (err) {
      logger.warn('HL7 inbound message rejected by authenticity check', {
        messageType,
        controlId,
        code: err.code,
        requestId: req.id,
      });
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res
        .status(err.statusCode || 401)
        .send(generateACK(controlId || 'UNKNOWN', 'AR', err.message || 'HL7 message authentication failed'));
    }

    logger.info('HL7 message received', {
      messageType,
      controlId,
      sendingApp: parsed.msh.sendingApp,
      requestId: req.id,
    });

    try {
      // Route based on message type
      if (messageType === 'ADT^A01' || messageType === 'ADT^A02' || messageType === 'ADT^A03') {
        const { admission, patient } = parseADTToAdmission(message);

        if (!patient.uid) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(400).send(generateACK(controlId, 'AE', 'Patient identifier (PID.3) is required'));
        }
        const patientRow = await loadHl7Patient(patient.uid);
        if (!patientRow) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(404).send(generateACK(controlId, 'AE', 'Patient is not registered at this facility'));
        }

        if (messageType === 'ADT^A01' || messageType === 'ADT^A02') {
          // Create admission — scoped to the patient's tenant so the RLS
          // WITH CHECK confirms the row lands in that tenant (and the
          // tenant_id GUC default resolves to it).
          await setTenant(patientRow.tenant_id, (tx) => tx.$queryRawUnsafe(
            `INSERT INTO admissions (patient_uid, status, ward, bed_number, admitting_doctor, admitted_at, reason, tenant_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, NOW())
             ON CONFLICT DO NOTHING`,
            patient.uid,
            admission.status || 'ADMITTED',
            admission.ward || null,
            admission.bed_number || null,
            admission.admitting_doctor || null,
            admission.admitted_at || new Date().toISOString(),
            null,
            patientRow.tenant_id,
          ));
        } else if (messageType === 'ADT^A03') {
          // Discharge — update most recent admission for this patient, scoped
          // to the patient's tenant.
          await setTenant(patientRow.tenant_id, (tx) => tx.$queryRawUnsafe(
            `UPDATE admissions SET status = 'DISCHARGED', discharged_at = $2
             WHERE id = (
               SELECT id FROM admissions
                WHERE patient_uid = $1 AND tenant_id = $3::uuid AND status = 'ADMITTED'
                ORDER BY admitted_at DESC
                LIMIT 1
             )`,
            patient.uid, admission.discharged_at || new Date().toISOString(), patientRow.tenant_id,
          ));
        }

        logger.info('HL7 ADT processed', { messageType, patientUid: patient.uid, requestId: req.id });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(200).send(generateACK(controlId, 'AA', 'Message accepted'));
      }

      if (messageType === 'ORM^O01') {
        const { order, patient } = parseORMToOrder(message);

        if (!patient.uid) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(400).send(generateACK(controlId, 'AE', 'Patient identifier (PID.3) is required'));
        }
        const patientRow = await loadHl7Patient(patient.uid);
        if (!patientRow) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(404).send(generateACK(controlId, 'AE', 'Patient is not registered at this facility'));
        }

        await setTenant(patientRow.tenant_id, (tx) => tx.$queryRawUnsafe(
          `INSERT INTO investigations (patient_uid, phone, test_name, status, requested_at, tenant_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::uuid, NOW(), NOW())`,
          patient.uid,
          patientRow.phone,
          order.test_name || 'Unknown Test',
          order.status || 'PENDING',
          order.ordered_at || new Date().toISOString(),
          patientRow.tenant_id,
        ));

        logger.info('HL7 ORM processed', { testName: order.test_name, patientUid: patient.uid, requestId: req.id });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(200).send(generateACK(controlId, 'AA', 'Order accepted'));
      }

      if (messageType === 'ORU^R01') {
        // Inbound lab result. Map OBX segments to structured_results and
        // attach to the most recent matching pending investigation for the
        // patient. If none, create a new investigation so the result isn't
        // dropped.
        const patientUid = parsed.pid?.uid || parsed.pid?.patientId;
        if (!patientUid) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(400).send(generateACK(controlId, 'AE', 'Patient identifier (PID.3) is required'));
        }
        const patientRow = await loadHl7Patient(patientUid);
        if (!patientRow) {
          res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
          return res.status(404).send(generateACK(controlId, 'AE', 'Patient is not registered at this facility'));
        }

        const observations = (parsed.obx || []).map((o) => ({
          code: o.observationId || null, // typically LOINC when sender populates it
          value: o.value,
          units: o.units,
          referenceRange: o.referenceRange,
          abnormalFlag: o.abnormalFlag,
          resultStatus: o.resultStatus,
          valueType: o.valueType,
        }));

        const testName = parsed.obr?.universalServiceId || observations[0]?.code || 'Lab Result';

        // Attach-or-create scoped to the patient's tenant. The match + the
        // fallback insert share one setTenant scope so both are RLS-checked
        // against THAT tenant.
        const matched = await setTenant(patientRow.tenant_id, async (tx) => {
          const updated = await tx.$queryRawUnsafe(
            `UPDATE investigations
                SET structured_results = $2::jsonb,
                    status = 'COMPLETED',
                    completed_at = NOW(),
                    result_uploaded_at = NOW()
              WHERE patient_uid = $1::uuid
                AND tenant_id = $4::uuid
                AND status IN ('REQUESTED', 'PENDING', 'IN_PROGRESS')
                AND (test_name = $3 OR test_name = 'Unknown Test')
                AND id = (
                  SELECT id FROM investigations
                   WHERE patient_uid = $1::uuid
                     AND tenant_id = $4::uuid
                     AND status IN ('REQUESTED', 'PENDING', 'IN_PROGRESS')
                   ORDER BY requested_at DESC
                   LIMIT 1
                )
              RETURNING id`,
            patientUid,
            JSON.stringify(observations),
            testName,
            patientRow.tenant_id,
          );

          if (updated.length === 0) {
            await tx.$queryRawUnsafe(
              `INSERT INTO investigations (patient_uid, phone, test_name, status, structured_results, completed_at, tenant_id, created_at, updated_at)
               VALUES ($1::uuid, $2, $3, 'COMPLETED', $4::jsonb, NOW(), $5::uuid, NOW(), NOW())`,
              patientUid,
              patientRow.phone,
              testName,
              JSON.stringify(observations),
              patientRow.tenant_id,
            );
          }
          return updated;
        });

        logger.info('HL7 ORU processed', {
          patientUid,
          testName,
          observationCount: observations.length,
          attached: matched.length > 0,
          requestId: req.id,
        });
        res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
        return res.status(200).send(generateACK(controlId, 'AA', 'Result accepted'));
      }

      // Unsupported message type
      logger.warn('HL7 unsupported message type', { messageType, requestId: req.id });
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res.status(200).send(generateACK(controlId, 'AE', `Unsupported message type: ${messageType}`));
    } catch (err) {
      logger.error('HL7 processing error', { messageType, error: err.message, requestId: req.id });
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res.status(500).send(generateACK(controlId, 'AE', 'Internal processing error'));
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
        `SELECT id, patient_uid, uid, test_name, investigation_type, status,
                results, conclusion, interpretation, ordered_at, completed_at, created_at
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
        hl7Message = orderToORM(investigation, patient);
      } else {
        hl7Message = resultToORU(investigation, patient);
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
