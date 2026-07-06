#!/usr/bin/env node
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { CompactEncrypt } from 'jose';

const DEFAULT_VERSION_PREFIX = '/v0.9';
const DEFAULT_PROVIDER_CODE = 'VH-NHCX-PROVIDER';
const DEFAULT_PAYER_CODE = 'PAYER-NHCX-MOCK';

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function header(req, ...names) {
  for (const name of names) {
    const value = req.headers[name] ?? req.headers[name.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function compactRequestSnapshot(req, body, endpoint) {
  const payload = body?.payload || '';
  const apiCallId = header(req, 'x-hcx-api_call_id', 'x-hcx-api-call-id');
  const correlationId = header(req, 'x-hcx-correlation_id', 'x-hcx-correlation-id');
  const workflowId = header(req, 'x-hcx-workflow_id', 'x-hcx-workflow-id');
  const stableId = sha256([endpoint, apiCallId, correlationId, workflowId, payload].filter(Boolean).join('|')).slice(0, 24);
  return {
    id: stableId,
    endpoint,
    method: req.method,
    api_call_id: apiCallId,
    correlation_id: correlationId,
    workflow_id: workflowId,
    sender_code: header(req, 'sender_code', 'x-hcx-sender_code', 'x-hcx-sender-code') || DEFAULT_PROVIDER_CODE,
    recipient_code: header(req, 'recipient_code', 'x-hcx-recipient_code', 'x-hcx-recipient-code') || DEFAULT_PAYER_CODE,
    mock_outcome: header(req, 'x-nhcx-mock-outcome') || body?.mock_outcome || body?.mockOutcome || 'approve',
    payload_hash: sha256(payload),
    payload_segments: String(payload).split('.').length,
    received_at: new Date().toISOString(),
  };
}

function symmetricKey(secret) {
  return crypto.createHash('sha256').update(String(secret || 'nhcx-mock-jwe-secret')).digest();
}

async function encryptCallbackBundle(bundle, secret) {
  const plaintext = new TextEncoder().encode(JSON.stringify(bundle));
  return new CompactEncrypt(plaintext)
    .setProtectedHeader({
      alg: 'dir',
      enc: 'A256GCM',
      typ: 'JWE',
      cty: 'application/fhir+json',
      kid: 'nhcx-mock-symmetric',
    })
    .encrypt(symmetricKey(secret));
}

function signPayload({ secret, timestamp, requestId, payload }) {
  const canonical = `${timestamp}.${requestId}.${JSON.stringify(payload || {})}`;
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

function eligibilityResponseBundle(snapshot) {
  return {
    resourceType: 'Bundle',
    id: `mock-eligibility-response-${snapshot.id}`,
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/CoverageEligibilityResponseBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'CoverageEligibilityResponse',
        id: `eligibility-response-${snapshot.id}`,
        status: 'active',
        purpose: ['benefits', 'validation'],
        outcome: 'complete',
        disposition: 'Mock NHCX eligibility accepted',
        created: new Date().toISOString(),
        request: { identifier: { value: snapshot.api_call_id || snapshot.id } },
      },
    }],
  };
}

function preauthClaimResponseBundle(snapshot) {
  const preauthRef = snapshot.workflow_id && /^\d+$/.test(snapshot.workflow_id)
    ? `Claim/preauth-${snapshot.workflow_id}`
    : 'Claim/preauth-1';
  return {
    resourceType: 'Bundle',
    id: `mock-preauth-response-${snapshot.id}`,
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimResponseBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'ClaimResponse',
        id: `claim-response-${snapshot.id}`,
        status: 'active',
        use: 'preauthorization',
        outcome: 'complete',
        disposition: 'Approved by mock NHCX payer',
        request: { reference: preauthRef },
        total: [{ amount: { value: 50000, currency: 'INR' } }],
        processNote: [{ text: 'Mock approval for local smoke testing' }],
      },
    }],
  };
}

function claimResponseBundle(snapshot) {
  const claimRef = snapshot.workflow_id && /^\d+$/.test(snapshot.workflow_id)
    ? `Claim/claim-${snapshot.workflow_id}`
    : 'Claim/claim-1';
  const outcome = String(snapshot.mock_outcome || 'approve').toLowerCase();
  const variants = {
    approve: {
      outcome: 'complete',
      disposition: 'Approved by mock NHCX payer',
      amount: 50000,
      note: 'Mock final claim approval for local smoke testing',
    },
    partial: {
      outcome: 'partial',
      disposition: 'Partially approved by mock NHCX payer',
      amount: 42000,
      note: 'Mock partial approval with disallowed balance',
    },
    deny: {
      outcome: 'error',
      disposition: 'Denied by mock NHCX payer',
      amount: 0,
      note: 'Mock denial for local smoke testing',
    },
    query: {
      outcome: 'queued',
      disposition: 'Additional information requested by mock NHCX payer',
      amount: null,
      note: 'Please upload the signed discharge summary and itemized final bill',
    },
  };
  const selected = variants[outcome] || variants.approve;
  return {
    resourceType: 'Bundle',
    id: `mock-claim-response-${snapshot.id}-${outcome}`,
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimResponseBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'ClaimResponse',
        id: `claim-response-${snapshot.id}-${outcome}`,
        status: 'active',
        use: 'claim',
        outcome: selected.outcome,
        disposition: selected.disposition,
        request: { reference: claimRef },
        total: selected.amount == null ? [] : [{ amount: { value: selected.amount, currency: 'INR' } }],
        processNote: [{ text: selected.note }],
      },
    }],
  };
}

function claimStatusTaskBundle(snapshot) {
  return {
    resourceType: 'Bundle',
    id: `mock-claim-status-${snapshot.id}`,
    meta: {
      profile: ['https://www.nrces.in/ndhm/fhir/r4/StructureDefinition/TaskBundle'],
      versionId: '7.0.0-design-target',
    },
    type: 'collection',
    entry: [{
      resource: {
        resourceType: 'Task',
        id: `claim-status-${snapshot.id}`,
        status: 'completed',
        intent: 'order',
        code: {
          coding: [{ system: 'https://hcxprotocol.io/task-code', code: 'status-check' }],
          text: 'NHCX claim status check',
        },
        for: { reference: 'Patient/mock' },
        authoredOn: new Date().toISOString(),
        output: [{
          type: { text: 'gateway-status' },
          valueString: 'accepted',
        }],
      },
    }],
  };
}

async function maybePostCallback({ snapshot, endpoint, options, state }) {
  const callbackBaseUrl = options.callbackBaseUrl;
  if (!callbackBaseUrl) return null;

  const callbackEndpointByRequest = {
    'coverageeligibility/check': 'coverageeligibility/on_check',
    'preauth/submit': 'preauth/on_submit',
    'claim/submit': 'claim/on_submit',
    'claim/status': 'claim/on_status',
  };
  const callbackEndpoint = callbackEndpointByRequest[endpoint];
  const bundleByRequest = {
    'coverageeligibility/check': eligibilityResponseBundle,
    'preauth/submit': preauthClaimResponseBundle,
    'claim/submit': claimResponseBundle,
    'claim/status': claimStatusTaskBundle,
  };
  const bundle = bundleByRequest[endpoint](snapshot);
  const payload = await encryptCallbackBundle(bundle, options.jweSecret);
  const timestamp = String(Date.now());
  const requestId = `mock-callback-${snapshot.id}`;
  const body = {
    payload,
    protected_headers: {
      recipient_code: snapshot.sender_code,
      sender_code: snapshot.recipient_code,
      'x-hcx-api_call_id': requestId,
      'x-hcx-correlation_id': snapshot.correlation_id,
      'x-hcx-workflow_id': snapshot.workflow_id,
      status: 'accepted',
      mock_outcome: snapshot.mock_outcome,
    },
  };
  const signature = signPayload({
    secret: options.callbackSecret,
    timestamp,
    requestId,
    payload: body,
  });
  const url = new URL(callbackEndpoint, callbackBaseUrl.endsWith('/') ? callbackBaseUrl : `${callbackBaseUrl}/`);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hcx-recipient_code': snapshot.sender_code,
      'x-hcx-sender_code': snapshot.recipient_code,
      'x-hcx-api_call_id': requestId,
      'x-hcx-correlation_id': snapshot.correlation_id || '',
      'x-hcx-workflow_id': snapshot.workflow_id || '',
      'x-hcx-timestamp': timestamp,
      'x-hcx-request-id': requestId,
      'x-nhcx-signature': signature,
    },
    body: JSON.stringify(body),
  });
  const callbackRecord = {
    endpoint: callbackEndpoint,
    status: response.status,
    request_id: requestId,
    correlation_id: snapshot.correlation_id,
    workflow_id: snapshot.workflow_id,
    mock_outcome: snapshot.mock_outcome,
    posted_at: new Date().toISOString(),
  };
  state.callbacks.push(callbackRecord);
  return callbackRecord;
}

export function startMockNHCXExchange(options = {}) {
  const state = {
    requests: [],
    callbacks: [],
  };
  const versionPrefix = options.versionPrefix || DEFAULT_VERSION_PREFIX;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/__admin/requests') {
        return json(res, 200, state);
      }
      if (req.method === 'POST' && url.pathname === '/__admin/reset') {
        state.requests = [];
        state.callbacks = [];
        return json(res, 200, { ok: true });
      }

      const endpoint = url.pathname.replace(new RegExp(`^${versionPrefix.replace(/\./g, '\\.')}/?`), '');
      const supported = endpoint === 'coverageeligibility/check'
        || endpoint === 'preauth/submit'
        || endpoint === 'claim/submit'
        || endpoint === 'claim/status';
      if (req.method !== 'POST' || !supported) {
        return json(res, 404, { error: 'not_found' });
      }

      const body = await readJson(req);
      const snapshot = compactRequestSnapshot(req, body, endpoint);
      state.requests.push(snapshot);
      maybePostCallback({ snapshot, endpoint, options, state }).catch((err) => {
        state.callbacks.push({
          endpoint,
          status: 'failed',
          error: err.message,
          posted_at: new Date().toISOString(),
        });
      });
      return json(res, 202, {
        status: 'accepted',
        reference_id: `MOCK-${snapshot.id}`,
        endpoint,
        payload_hash: snapshot.payload_hash,
      });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  });

  const port = Number(options.port || process.env.NHCX_MOCK_PORT || 0);
  const host = options.host || process.env.NHCX_MOCK_HOST || '127.0.0.1';
  const ready = new Promise((resolve) => {
    server.listen(port, host, () => {
      const address = server.address();
      const baseUrl = `http://${address.address}:${address.port}${versionPrefix}`;
      resolve({ server, state, baseUrl, adminUrl: `http://${address.address}:${address.port}/__admin/requests` });
    });
  });
  return { server, state, ready };
}

async function main() {
  const { ready } = startMockNHCXExchange({
    callbackBaseUrl: process.env.NHCX_MOCK_CALLBACK_BASE_URL || null,
    callbackSecret: process.env.NHCX_MOCK_CALLBACK_SECRET || 'test-callback-secret',
    jweSecret: process.env.NHCX_MOCK_JWE_SECRET || 'test-jwe-secret-32-byte-minimum',
  });
  const info = await ready;
  console.log(`NHCX mock exchange listening at ${info.baseUrl}`);
  console.log(`Request log: ${info.adminUrl}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
