// src/routes/quality/infectionControlRoutes.js
//
// Roadmap D5 — infection-control workbench. Mounted at
// /api/v1/infection-control (app.js) behind the IC/quality role gate.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  isolationBoard,
  traceContacts,
  antibiogram,
} from '../../services/quality/infectionControlWorkbenchService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';

const router = express.Router();

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Infection control ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

// GET /isolation-board?ward=... — active isolation cases on the bed board.
router.get('/isolation-board', async (req, res) => {
  try {
    const cases = await isolationBoard({
      ward: req.query.ward || null,
      tenantId: req.tenantId,
    });
    return success(res, { cases, count: cases.length }, 'Isolation board');
  } catch (err) {
    return handleFailure(res, err, 'build isolation board');
  }
});

// GET /contacts?patient_uid=&from=&to= — ADT ward-overlap contact tracing.
router.get('/contacts', async (req, res) => {
  try {
    const contacts = await traceContacts({
      patientUid: req.query.patient_uid,
      from: req.query.from,
      to: req.query.to,
      tenantId: req.tenantId,
    });
    return success(res, { contacts, count: contacts.length }, 'Ward-overlap contacts');
  } catch (err) {
    return handleFailure(res, err, 'trace contacts');
  }
});

// GET /antibiogram?from=&to=&min_isolates= — susceptibility matrix + flags.
router.get('/antibiogram', async (req, res) => {
  try {
    const result = await antibiogram({
      from: req.query.from,
      to: req.query.to,
      minIsolates: req.query.min_isolates,
      tenantId: req.tenantId,
    });
    return success(res, result, 'Antibiogram');
  } catch (err) {
    return handleFailure(res, err, 'compute antibiogram');
  }
});

export default router;
