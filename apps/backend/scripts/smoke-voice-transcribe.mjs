#!/usr/bin/env node
/**
 * Operator smoke for Staff Dictation V1 STT.
 *
 * Starts no services. Point this at a running backend that has:
 *   STT_PROVIDER=openai-compatible
 *   STT_BASE_URL=http://127.0.0.1:<faster-whisper-port>
 *   STT_MODEL=<model>
 *
 * Required:
 *   --audio <path> or VOICE_SMOKE_AUDIO_PATH=<path>
 *
 * Optional auth:
 *   VOICE_SMOKE_TOKEN=<jwt>
 *   or JWT_SECRET + VOICE_SMOKE_UID/VOICE_SMOKE_ROLE/VOICE_SMOKE_TENANT_ID.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import jwt from 'jsonwebtoken';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, 'true');
  }
}

function option(name, envName, fallback = '') {
  return String(args.get(name) || process.env[envName] || fallback).trim();
}

function required(name, value) {
  if (!value) {
    throw new Error(`Missing required option: ${name}`);
  }
  return value;
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.m4a') return 'audio/m4a';
  if (ext === '.webm') return 'audio/webm';
  if (ext === '.ogg') return 'audio/ogg';
  return 'audio/wav';
}

function makeToken() {
  const supplied = option('token', 'VOICE_SMOKE_TOKEN');
  if (supplied) return supplied;

  const secret = option('jwt-secret', 'JWT_SECRET', 'vhhealth-local-admin-smoke-secret-123456789');
  const uid = option('uid', 'VOICE_SMOKE_UID', '88888888-8888-4888-8888-888888888888');
  const role = option('role', 'VOICE_SMOKE_ROLE', 'DOCTOR');
  const tenantId = option('tenant-id', 'VOICE_SMOKE_TENANT_ID', '00000000-0000-4000-8000-000000000001');
  return jwt.sign({
    uid,
    sub: uid,
    role,
    tenant_id: tenantId,
    email: `${uid}@voice-transcribe-smoke.local`,
  }, secret, { expiresIn: '30m' });
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    throw new Error(`Non-JSON response from ${url}: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

async function main() {
  const baseUrl = option('base-url', 'VOICE_SMOKE_BASE_URL', 'http://127.0.0.1:5206').replace(/\/+$/, '');
  const audioPath = required('--audio or VOICE_SMOKE_AUDIO_PATH', option('audio', 'VOICE_SMOKE_AUDIO_PATH'));
  const apiKey = option('api-key', 'API_KEY', 'vhhealth-local-api-key');
  const expectedProvider = option('expected-provider', 'VOICE_SMOKE_EXPECTED_PROVIDER', 'openai-compatible');
  const patientUid = option('patient-uid', 'VOICE_SMOKE_PATIENT_UID');
  const admissionId = option('admission-id', 'VOICE_SMOKE_ADMISSION_ID');
  const language = option('language', 'VOICE_SMOKE_LANGUAGE');
  const token = makeToken();

  const headers = {
    'x-api-key': apiKey,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  const config = await requestJson(`${baseUrl}/api/v1/clinical/voice-note/config`, { headers });
  const stt = config?.data || {};
  if (stt.configured !== true) {
    throw new Error(`STT is not configured: ${stt.provider || 'unknown'} ${stt.reason || ''}`.trim());
  }
  if (expectedProvider && stt.provider !== expectedProvider) {
    throw new Error(`Expected STT provider ${expectedProvider}, got ${stt.provider}`);
  }

  const audio = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('audio', new Blob([audio], { type: guessMime(audioPath) }), path.basename(audioPath));
  if (patientUid) form.append('patient_uid', patientUid);
  if (admissionId) form.append('admission_id', admissionId);
  if (language) form.append('language', language);

  const uploaded = await requestJson(`${baseUrl}/api/v1/clinical/voice-note/transcribe`, {
    method: 'POST',
    headers,
    body: form,
  });
  const row = uploaded?.data || {};
  const transcript = String(row.transcript || '').trim();
  if (row.transcript_status !== 'completed') {
    throw new Error(`Transcript did not complete: status=${row.transcript_status} reason=${row.transcript_failure_reason || ''}`);
  }
  if (!transcript) {
    throw new Error('Transcript was empty');
  }
  if (expectedProvider && row.stt_provider !== expectedProvider) {
    throw new Error(`clinical_voice_notes row recorded provider ${row.stt_provider}, expected ${expectedProvider}`);
  }

  console.log(JSON.stringify({
    ok: true,
    voice_note_id: row.id,
    stt_provider: row.stt_provider,
    stt_model: row.stt_model,
    transcript_chars: transcript.length,
    patient_uid: row.patient_uid || null,
    admission_id: row.admission_id || null,
  }, null, 2));
}

main().catch((err) => {
  console.error(`Voice transcribe smoke failed: ${err.message}`);
  process.exit(1);
});
