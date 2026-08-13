import express from 'express';

import { receiveHttpHl7Message } from '../../services/interfaceEngine/interfaceEngineService.js';
import { generateACK, parseHL7 } from '../../services/hl7/hl7Parser.js';
import { AppError } from '../../utils/AppError.js';
import { resolveIngressClientIp } from '../../utils/trustedProxy.js';

const router = express.Router();

function extractMessage(req) {
  if (typeof req.body === 'string') return req.body;
  return req.body?.message || req.body?.payload || null;
}

function controlIdFor(message) {
  try {
    return parseHL7(message).msh?.messageControlId || 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

router.post('/channels/:channelKey/hl7', async (req, res, next) => {
  const message = extractMessage(req);
  const controlId = controlIdFor(message);
  try {
    if (!message || typeof message !== 'string') {
      res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
      return res.status(400).send(generateACK(controlId, 'AR', 'HL7 message is required'));
    }
    const row = await receiveHttpHl7Message({
      channelKey: req.params.channelKey,
      message,
      headers: req.headers,
      sourceIp: resolveIngressClientIp(req),
    });
    if (row.status !== 'delivered') {
      throw AppError.conflict(
        'HL7 message was validated but not delivered to a clinical backend',
        'INTEROP_HL7_NOT_DELIVERED',
      );
    }
    res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
    return res.status(200).send(generateACK(row.external_control_id || controlId, 'AA', 'Message accepted'));
  } catch (err) {
    const status = err?.statusCode || 500;
    const ackCode = status === 400 ? 'AR' : 'AE';
    const safeText = err?.code || 'INTEROP_HL7_REJECTED';
    res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
    if (status >= 500) return next(err);
    return res.status(status).send(generateACK(controlId, ackCode, safeText));
  }
});

export default router;
