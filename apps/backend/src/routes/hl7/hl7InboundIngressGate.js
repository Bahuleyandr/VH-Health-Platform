// src/routes/hl7/hl7InboundIngressGate.js
//
// HL7_INBOUND_ENABLED is the AUTHORITY over the I03 HTTP-bridge ingress
// (`POST /api/v1/hl7/receive`), not a piece of documentation.
//
// Audit 2026-08-13: the flag was declared `"false"` in
// `infra/kubernetes/apps/backend/configmap.yaml:118` and existed in code only
// as a Joi schema key in `src/utils/validateEnv.js:23` — where its sole effect
// was to make HL7_INBOUND_SHARED_SECRET conditionally required. Nothing ever
// read it as a gate: `app.js` mounted the HL7 router unconditionally, so a
// deployment that declared inbound HL7 OFF still accepted signed HL7v2
// messages against
//   * an active DB-backed `tenant_interop_secrets` row (purpose
//     `hl7_inbound`), resolved in `hl7Routes.js#assertHl7InboundAuthentic`, or
//   * a retained legacy `HL7_INBOUND_SHARED_SECRET` env value, which the same
//     function still falls back to for the default tenant.
// Both are credentials that survive turning the interface "off", so "off"
// meant nothing. This module makes it mean something.
//
// Fail-closed contract:
//   * ONLY the exact string 'true' enables ingress. Unset, empty, 'True',
//     '1', 'yes', ' true ' (padded), or any other spelling is OFF. Deliberately
//     no trim and no case folding: validateEnv's Joi `.valid('true','false')`
//     already refuses to boot on any other spelling, so a padded value cannot
//     legitimately reach runtime — and if one ever did, the fail-closed answer
//     is OFF rather than "enable ingress on a value nobody validated".
//     (validateEnv defaults the variable to 'false', but it validates a COPY
//     of process.env and never writes the default back, so the runtime value
//     can legitimately be `undefined` — that must read OFF too.)
//   * The gate runs BEFORE any credential resolution, any database read, and
//     any HMAC verification, so a disabled interface cannot be probed for
//     credential state and performs no work on an attacker's behalf.
//   * The refusal is an HL7 ACK (the sender speaks HL7v2, not JSON) carrying
//     `AR` — application reject. The interface is administratively off; a
//     retry against the same disabled endpoint will be refused identically,
//     so this is deliberately NOT a 5xx/`AE` that invites a retry storm.
//
// The value is read per request rather than captured at import time so the
// gate is observable from tests without re-importing the Express app; in a
// deployment the environment is fixed for the life of the process either way.

import logger from '../../logging/logger.js';
import { generateACK } from '../../services/hl7/hl7Parser.js';
import { AppError } from '../../utils/AppError.js';

export const HL7_INBOUND_DISABLED_CODE = 'HL7_INBOUND_DISABLED';
export const HL7_INBOUND_DISABLED_MESSAGE = 'HL7 inbound ingress is disabled';

export function isHl7InboundIngressEnabled() {
  return process.env.HL7_INBOUND_ENABLED === 'true';
}

// Credential-boundary guard. Called from the authenticity check so that no
// credential — DB-backed or legacy env — can ever authenticate an inbound
// message while the interface is declared off, independent of how the request
// was routed here.
export function assertHl7InboundIngressEnabled() {
  if (isHl7InboundIngressEnabled()) return;
  throw AppError.forbidden(HL7_INBOUND_DISABLED_MESSAGE, HL7_INBOUND_DISABLED_CODE);
}

// Mount-boundary guard. Answers with a raw HL7 ACK without touching the body,
// the database, or any secret.
export function hl7InboundIngressGate(req, res, next) {
  if (isHl7InboundIngressEnabled()) return next();
  logger.warn('HL7 inbound ingress refused: interface is disabled', {
    code: HL7_INBOUND_DISABLED_CODE,
    requestId: req.id,
  });
  res.setHeader('Content-Type', 'application/hl7-v2; charset=utf-8');
  return res.status(403).send(generateACK('UNKNOWN', 'AR', HL7_INBOUND_DISABLED_MESSAGE));
}

export default hl7InboundIngressGate;
