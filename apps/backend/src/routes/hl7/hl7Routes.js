// src/routes/hl7/hl7Routes.js
// HL7v2 messaging routes — HTTP bridge for MLLP-style HL7v2 message exchange.

import express from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import jwtAuth from '../../middleware/jwtMiddleware.js';
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

const router = express.Router();

// ---------------------------------------------------------------------------
// Helper: async route wrapper
// ---------------------------------------------------------------------------
function wrapAsync(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
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

        if (messageType === 'ADT^A01' || messageType === 'ADT^A02') {
          // Create admission
          await prisma.$queryRawUnsafe(
            `INSERT INTO admissions (patient_uid, status, ward, bed_number, admitting_doctor, admitted_at, reason, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT DO NOTHING`,
            
              patient.uid,
              admission.status || 'ADMITTED',
              admission.ward || null,
              admission.bed_number || null,
              admission.admitting_doctor || null,
              admission.admitted_at || new Date().toISOString(),
              null,
            
          );
        } else if (messageType === 'ADT^A03') {
          // Discharge — update most recent admission for this patient
          await prisma.$queryRawUnsafe(
            `UPDATE admissions SET status = 'DISCHARGED', discharged_at = $2
             WHERE patient_uid = $1 AND status = 'ADMITTED'
             ORDER BY admitted_at DESC LIMIT 1`,
            patient.uid, admission.discharged_at || new Date().toISOString()
          );
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

        await prisma.$queryRawUnsafe(
          `INSERT INTO investigations (patient_uid, test_name, status, ordered_at, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          
            patient.uid,
            order.test_name || 'Unknown Test',
            order.status || 'PENDING',
            order.ordered_at || new Date().toISOString(),
          
        );

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

        const matched = await prisma.$queryRawUnsafe(
          `UPDATE investigations
              SET structured_results = $2::jsonb,
                  status = 'COMPLETED',
                  completed_at = NOW(),
                  result_uploaded_at = NOW()
            WHERE patient_uid = $1::uuid
              AND status IN ('REQUESTED', 'PENDING', 'IN_PROGRESS')
              AND (test_name = $3 OR test_name = 'Unknown Test')
              AND id = (
                SELECT id FROM investigations
                 WHERE patient_uid = $1::uuid
                   AND status IN ('REQUESTED', 'PENDING', 'IN_PROGRESS')
                 ORDER BY requested_at DESC
                 LIMIT 1
              )
            RETURNING id`,
          patientUid,
          JSON.stringify(observations),
          testName,
        );

        if (matched.length === 0) {
          await prisma.$queryRawUnsafe(
            `INSERT INTO investigations (patient_uid, test_name, status, structured_results, completed_at, created_at)
             VALUES ($1::uuid, $2, 'COMPLETED', $3::jsonb, NOW(), NOW())`,
            patientUid,
            testName,
            JSON.stringify(observations),
          );
        }

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
         FROM admissions WHERE id = $1 LIMIT 1`,
        admission_id
      );

      if (!admissionRows.length) {
        throw AppError.notFound('Admission not found');
      }

      const admission = admissionRows[0];

      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT uid, name, phone, gender, birthday, address FROM users WHERE uid = $1 LIMIT 1`,
        admission.patient_uid
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
         FROM investigations WHERE id = $1 LIMIT 1`,
        investigation_id
      );

      if (!investigationRows.length) {
        throw AppError.notFound('Investigation not found');
      }

      const investigation = investigationRows[0];
      const patientUid = investigation.patient_uid || investigation.uid;

      const patientRows = await prisma.$queryRawUnsafe(
        `SELECT uid, name, phone, gender, birthday, address FROM users WHERE uid = $1 LIMIT 1`,
        patientUid
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
