#!/usr/bin/env node
/**
 * Operator-only NL-3 P1 teleconsult smoke.
 *
 * This writes staging/test fixtures: it provisions the LiveKit-backed
 * teleconsult row for an existing TELE appointment, records patient consent,
 * mints patient + clinician tokens, and verifies TTL/grants/metadata locally.
 *
 * It never contacts LiveKit and must not be wired into CI.
 *
 * Usage:
 *   TELECONSULT_SMOKE_CONFIRM=I_UNDERSTAND_THIS_WRITES_FIXTURES \
 *   LIVEKIT_ENABLED=true \
 *   LIVEKIT_SERVER_URL=https://teleconsult.vhhealth.app \
 *   LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... \
 *   DATABASE_URL=... \
 *   node scripts/smoke-teleconsult-token.mjs \
 *     --tenant-id=<uuid> --appointment-id=<tele-appointment-id>
 */

import 'dotenv/config';

import jwt from 'jsonwebtoken';

import prisma from '../src/lib/prisma.js';
import {
  ensureTeleconsultationForAppointment,
  getTeleconsultRoomState,
  issueJoinToken,
  recordTeleconsultConsent,
} from '../src/services/telemedicine/teleconsultProvisioningService.js';

const CONFIRM_PHRASE = 'I_UNDERSTAND_THIS_WRITES_FIXTURES';
const ALLOWED_METADATA_KEYS = ['appointment_id', 'role', 'teleconsultation_id', 'tenant_id'];
const FORBIDDEN_VIDEO_GRANTS = ['roomRecord', 'room_record', 'egress', 'ingressAdmin', 'recorder'];

function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > -1) {
      parsed[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      parsed[key] = next;
      i += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function fail(message, details = null) {
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : '';
  throw new Error(`[smoke-teleconsult-token] ${message}${suffix}`);
}

function requireOption(options, name) {
  const value = options[name] || process.env[name.toUpperCase().replaceAll('-', '_')];
  if (!value) fail(`missing required option --${name}`);
  return value;
}

function requireEnv(name) {
  if (!process.env[name]) fail(`${name} is required`);
  return process.env[name];
}

function parseMetadata(decoded) {
  let metadata;
  try {
    metadata = JSON.parse(decoded.metadata || '{}');
  } catch {
    fail('token metadata is not JSON', { metadata: decoded.metadata });
  }
  const keys = Object.keys(metadata).sort();
  if (JSON.stringify(keys) !== JSON.stringify(ALLOWED_METADATA_KEYS)) {
    fail('token metadata contains unexpected keys', { keys });
  }
  return metadata;
}

function verifyJoinToken({ tokenResult, role, participantUid, tenantId, teleconsultationId, appointmentId }) {
  const apiKey = requireEnv('LIVEKIT_API_KEY');
  const apiSecret = requireEnv('LIVEKIT_API_SECRET');
  const identity = `${role}:${participantUid}`;
  const decoded = jwt.verify(tokenResult.participant_token, apiSecret, {
    algorithms: ['HS256'],
    issuer: apiKey,
    subject: identity,
  });

  const ttlSeconds = Number(decoded.exp) - Number(decoded.iat);
  if (ttlSeconds < 300 || ttlSeconds > 600) {
    fail('token TTL is outside the approved 300-600 second window', { role, ttlSeconds });
  }

  const grant = decoded.video || {};
  for (const key of FORBIDDEN_VIDEO_GRANTS) {
    if (Object.prototype.hasOwnProperty.call(grant, key)) {
      fail('token includes a forbidden recording/egress grant', { role, key, grant });
    }
  }

  const metadata = parseMetadata(decoded);
  const expected = {
    tenant_id: String(tenantId),
    teleconsultation_id: Number(teleconsultationId),
    appointment_id: Number(appointmentId),
    role,
  };
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    fail('token metadata mismatch', { role, metadata, expected });
  }

  if (role === 'observer' && grant.canPublish !== false) {
    fail('observer token can publish', { grant });
  }
  if (role !== 'observer' && grant.canPublish !== true) {
    fail(`${role} token cannot publish`, { grant });
  }
  if (grant.roomRecord === true) {
    fail('token enables room recording', { grant });
  }

  return {
    identity,
    ttl_seconds: ttlSeconds,
    room: grant.room,
    grants: grant,
    metadata,
  };
}

async function main() {
  if (process.env.TELECONSULT_SMOKE_CONFIRM !== CONFIRM_PHRASE) {
    fail(`set TELECONSULT_SMOKE_CONFIRM=${CONFIRM_PHRASE}; this script writes smoke fixtures`);
  }
  requireEnv('DATABASE_URL');
  requireEnv('LIVEKIT_SERVER_URL');
  requireEnv('LIVEKIT_API_KEY');
  requireEnv('LIVEKIT_API_SECRET');
  if (String(process.env.LIVEKIT_ENABLED || 'false').toLowerCase() !== 'true') {
    fail('LIVEKIT_ENABLED must be true for this operator smoke');
  }

  const options = parseArgs();
  const tenantId = requireOption(options, 'tenant-id');
  const appointmentId = Number.parseInt(requireOption(options, 'appointment-id'), 10);
  if (!Number.isFinite(appointmentId) || appointmentId <= 0) {
    fail('--appointment-id must be a positive integer');
  }

  const teleconsultation = await ensureTeleconsultationForAppointment({
    tenantId,
    appointmentId,
    actorUid: options['clinician-uid'] || null,
    role: 'CLINICAL_STAFF',
  });
  const patientUid = teleconsultation.patient_uid;
  const clinicianUid = options['clinician-uid'] || teleconsultation.doctor_uid;
  if (!patientUid) fail('teleconsultation does not have patient_uid', teleconsultation);
  if (!clinicianUid) {
    fail('teleconsultation has no doctor_uid; pass --clinician-uid for an assigned care-team member');
  }

  const consented = await recordTeleconsultConsent({
    tenantId,
    teleconsultationId: teleconsultation.id,
    participantUid: patientUid,
    actorUid: patientUid,
    actorRole: 'PATIENT',
    consentPayload: {
      statement: 'NL-3 P1 teleconsult smoke consent',
      consent_method: 'operator_smoke',
      purpose: 'Remote video/audio consultation smoke',
      data_categories: [
        'teleconsult_video_audio',
        'teleconsult_lobby_state',
        'teleconsult_connection_metadata',
      ],
    },
  });

  const state = await getTeleconsultRoomState({
    tenantId,
    teleconsultationId: teleconsultation.id,
  });
  if (!state.consent_recorded) fail('consent did not persist before token issuance', state);

  const patientToken = await issueJoinToken({
    tenantId,
    teleconsultationId: teleconsultation.id,
    participantUid: patientUid,
    role: 'patient',
  });
  const clinicianToken = await issueJoinToken({
    tenantId,
    teleconsultationId: teleconsultation.id,
    participantUid: clinicianUid,
    role: 'clinician',
  });

  if (patientToken.room_name !== clinicianToken.room_name) {
    fail('patient and clinician tokens were minted for different rooms', {
      patient_room: patientToken.room_name,
      clinician_room: clinicianToken.room_name,
    });
  }

  const patientClaims = verifyJoinToken({
    tokenResult: patientToken,
    role: 'patient',
    participantUid: patientUid,
    tenantId,
    teleconsultationId: teleconsultation.id,
    appointmentId,
  });
  const clinicianClaims = verifyJoinToken({
    tokenResult: clinicianToken,
    role: 'clinician',
    participantUid: clinicianUid,
    tenantId,
    teleconsultationId: teleconsultation.id,
    appointmentId,
  });

  const report = {
    ok: true,
    tenant_id: tenantId,
    appointment_id: appointmentId,
    teleconsultation_id: teleconsultation.id,
    consent_id: consented.remote_consent_id,
    room_name: patientToken.room_name,
    server_url: patientToken.server_url,
    patient: patientClaims,
    clinician: clinicianClaims,
    recording_enabled: false,
    join_page: 'scripts/teleconsult-smoke-join.html',
  };

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('[smoke-teleconsult-token] PASS');
    console.log(`  appointment_id: ${report.appointment_id}`);
    console.log(`  teleconsultation_id: ${report.teleconsultation_id}`);
    console.log(`  room_name: ${report.room_name}`);
    console.log(`  server_url: ${report.server_url}`);
    console.log(`  patient_identity: ${report.patient.identity} ttl=${report.patient.ttl_seconds}s`);
    console.log(`  clinician_identity: ${report.clinician.identity} ttl=${report.clinician.ttl_seconds}s`);
    console.log('  recording grants: absent');
    console.log(`  manual join page: ${report.join_page}`);
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
