import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';

import { enableHl7InboundForTest } from './helpers/hl7InboundTestEnv.js';

// The I03 ingress is authoritative on HL7_INBOUND_ENABLED and fails closed
// when it is not exactly 'true'; declare the interface ON so these parser and
// limiter boundaries are exercised against a live ingress. The
// refused-while-off contract lives in hl7-inbound-disabled.deep.test.js.
//
// This module imports src/app.js below, which imports validateEnv — so the
// flag MUST arrive paired with HL7_INBOUND_SHARED_SECRET or the process exits
// before a single test runs. The helper is the only place that writes the pair.
enableHl7InboundForTest();

const previousBodyLimit = process.env.HTTP_BODY_LIMIT;
const previousPatientApiKey = process.env.API_KEY_PATIENT;
const previousStaffApiKey = process.env.API_KEY_STAFF;
process.env.HTTP_BODY_LIMIT = '1mb';
const LEGACY_RATE_KEY = `i03-legacy-rate-${randomUUID()}`;
const RECOVERY_RATE_KEY = `i03-recovery-rate-${randomUUID()}`;
process.env.API_KEY_PATIENT = LEGACY_RATE_KEY;
process.env.API_KEY_STAFF = RECOVERY_RATE_KEY;

const { RATE_LIMIT_PROFILES } = await import('../config/rateLimitProfiles.js');
const previousDefaultEnforceInTest = RATE_LIMIT_PROFILES.default.enforceInTest;
const previousDefaultMax = RATE_LIMIT_PROFILES.default.max;
RATE_LIMIT_PROFILES.default.enforceInTest = true;
const { default: app } = await import('../app.js');
const { default: prisma } = await import('../lib/prisma.js');
const { default: logger } = await import('../logging/logger.js');
const { I03_MAX_MESSAGE_BYTES } = await import(
  '../services/integrations/externalHl7InboundRecoveryService.js'
);
const { API_KEY } = await import('./testClient.js');
const AUDIT_AGENT_PREFIX = `i03-audit-body-${randomUUID()}`;
const LEGACY_LIMIT_BYTES = 1024 * 1024;

function expectRawAck(response, status, code) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain('application/hl7-v2');
  expect(response.text).toContain(`MSA|${code}`);
  expect(response.text).not.toContain(`MSA|${code === 'AE' ? 'AR' : 'AE'}`);
}

function expectJson(response, status, expectedBody) {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toContain('application/json');
  expect(response.body).toMatchObject(expectedBody);
}

function rawJsonWithEscapedMessage(messagePrefix, decodedBytes, { recovery = true } = {}) {
  const prefixBytes = Buffer.byteLength(messagePrefix, 'utf8');
  const fillBytes = decodedBytes - prefixBytes;
  if (fillBytes < 0) throw new Error('decoded test payload is smaller than its HL7 prefix');
  const encodedPrefix = JSON.stringify(messagePrefix).slice(1, -1);
  return `{"message":"${encodedPrefix}${'\\u0078'.repeat(fillBytes)}"${
    recovery ? ',"recovery":null' : ''
  }}`;
}

async function waitForAuditRow(userAgent) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT metadata, request_summary
         FROM audit_log
        WHERE user_agent = $1::text
        ORDER BY created_at DESC
        LIMIT 1`,
      userAgent,
    );
    if (rows[0]) return rows[0];
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the HL7 receive audit row');
}

describe('HL7 receive recovery-aware JSON parser', () => {
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_log WHERE user_agent LIKE $1::text`,
      `${AUDIT_AGENT_PREFIX}%`,
    );
    RATE_LIMIT_PROFILES.default.enforceInTest = previousDefaultEnforceInTest;
    RATE_LIMIT_PROFILES.default.max = previousDefaultMax;
    jest.restoreAllMocks();
    if (previousBodyLimit === undefined) delete process.env.HTTP_BODY_LIMIT;
    else process.env.HTTP_BODY_LIMIT = previousBodyLimit;
    if (previousPatientApiKey === undefined) delete process.env.API_KEY_PATIENT;
    else process.env.API_KEY_PATIENT = previousPatientApiKey;
    if (previousStaffApiKey === undefined) delete process.env.API_KEY_STAFF;
    else process.env.API_KEY_STAFF = previousStaffApiKey;
  });

  test('delivers an exact 2,000,000-byte highly escaped recovery message past both parser bounds', async () => {
    const prefix = 'MSH|^~\\&|EXT|SRC|VH|I03-LIMIT|20260806103045+0530||ADT^A01|LIMIT|P|2.5\rNTE|1||';
    const rawBody = rawJsonWithEscapedMessage(prefix, I03_MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(JSON.parse(rawBody).message, 'utf8')).toBe(I03_MAX_MESSAGE_BYTES);
    expect(Buffer.byteLength(rawBody, 'utf8')).toBeLessThan(12_100_000);

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-for', '198.51.100.10')
      .set('content-type', 'application/json')
      .send(rawBody);

    expectRawAck(response, 400, 'AR');
    expect(response.status).not.toBe(413);
  }, 30_000);

  test('rejects one decoded recovery byte over the service limit after the large parser accepts it', async () => {
    const prefix = 'MSH|^~\\&|EXT|SRC|VH|I03-LIMIT|20260806103045+0530||ADT^A01|LIMIT-OVER|P|2.5\rNTE|1||';
    const rawBody = rawJsonWithEscapedMessage(prefix, I03_MAX_MESSAGE_BYTES + 1);
    expect(Buffer.byteLength(rawBody, 'utf8')).toBeLessThan(12_100_000);

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-for', '198.51.100.11')
      .set('content-type', 'application/json')
      .send(rawBody);

    expectRawAck(response, 400, 'AR');
  }, 30_000);

  test('keeps envelope-less legacy HL7 at the configured 1mb raw-body boundary and JSON 413 shape', async () => {
    const prefix = 'MSH|^~\\&|EXT|SRC|VH|LEGACY-LIMIT|20260806103045+0530||ADT^A01|LEGACY|P|2.5\rNTE|1||';
    const emptyRawBody = JSON.stringify({ message: prefix });
    const atLimit = JSON.stringify({
      message: `${prefix}${'x'.repeat(LEGACY_LIMIT_BYTES - Buffer.byteLength(emptyRawBody, 'utf8'))}`,
    });
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(LEGACY_LIMIT_BYTES);

    const acceptedByParser = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-for', '198.51.100.12')
      .set('content-type', 'application/json')
      .send(atLimit);
    expectRawAck(acceptedByParser, 401, 'AR');

    const overLimit = `${atLimit.slice(0, -2)}x"}`;
    expect(Buffer.byteLength(overLimit, 'utf8')).toBe(LEGACY_LIMIT_BYTES + 1);
    const rejected = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-for', '198.51.100.13')
      .set('content-type', 'application/json')
      .send(overLimit);
    expectJson(rejected, 413, {
      success: false,
      message: 'request entity too large',
    });
  }, 30_000);

  test('keeps malformed envelope-less JSON ahead of API-key validation', async () => {
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-forwarded-for', '198.51.100.14')
      .set('content-type', 'application/json')
      .send('{"message":');

    expectJson(response, 400, {
      success: false,
      message: 'Unexpected end of JSON input',
    });
  });

  test('keeps malformed JSON above the legacy boundary on the old JSON 413 path', async () => {
    const malformed = `{"message":"${'x'.repeat(LEGACY_LIMIT_BYTES)}`;
    expect(Buffer.byteLength(malformed, 'utf8')).toBeGreaterThan(LEGACY_LIMIT_BYTES);

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-for', '198.51.100.15')
      .set('content-type', 'application/json')
      .send(malformed);

    expectJson(response, 413, {
      success: false,
      message: 'request entity too large',
    });
  });

  test('keeps envelope-less API-key validation JSON while converting marked recovery validation to ACK', async () => {
    const legacy = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-forwarded-for', '198.51.100.16')
      .send({ message: 'MSH|^~\\&|EXT|SRC|VH|LIVE|20260806103045+0530||ADT^A01|LIVE|P|2.5' });
    expectJson(legacy, 401, { error: 'Missing API Key in request headers' });

    const recovery = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-forwarded-for', '198.51.100.17')
      .send({
        message: 'MSH|^~\\&|EXT|SRC|VH|RECOVERY|20260806103045+0530||ADT^A01|RECOVERY|P|2.5',
        recovery: null,
      });
    expectRawAck(recovery, 401, 'AR');
  });

  test('keeps malformed-body errors JSON and drops query sentinels from logs', async () => {
    const sentinel = `HL7-QUERY-SENTINEL-${randomUUID()}`;
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const response = await request(app)
        .post(`/api/v1/hl7/receive?patient=${sentinel}`)
        .set('x-api-key', API_KEY)
        .set('x-forwarded-for', '198.51.100.18')
        .set('content-type', 'application/json')
        .send('{"message":"malformed"');

      expectJson(response, 400, {
        success: false,
        message: expect.stringContaining('after property value in JSON at position 22'),
      });
      const handlerLog = errorSpy.mock.calls.find(
        ([message]) => message === 'An error occurred while processing a request',
      );
      expect(handlerLog?.[1]?.request?.url).toBe('/api/v1/hl7/receive');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('keeps parser-ceiling errors JSON and drops oversized-body query sentinels from logs', async () => {
    const sentinel = `HL7-OVERSIZE-SENTINEL-${randomUUID()}`;
    const rawBody = rawJsonWithEscapedMessage('MSH|^~\\&|', 2_020_000);
    expect(Buffer.byteLength(rawBody, 'utf8')).toBeGreaterThan(12_100_000);
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      const response = await request(app)
        .post(`/api/v1/hl7/receive?patient=${sentinel}`)
        .set('x-api-key', API_KEY)
        .set('x-forwarded-for', '198.51.100.19')
        .set('content-type', 'application/json')
        .send(rawBody);

      expectJson(response, 413, {
        success: false,
        message: 'request entity too large',
      });
      const handlerLog = errorSpy.mock.calls.find(
        ([message]) => message === 'An error occurred while processing a request',
      );
      expect(handlerLog?.[1]?.request?.url).toBe('/api/v1/hl7/receive');
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
    } finally {
      errorSpy.mockRestore();
    }
  }, 30_000);

  test('retains the legacy authenticated API-key limiter and JSON 429 response', async () => {
    RATE_LIMIT_PROFILES.default.max = 2;
    try {
      const responses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        responses.push(await request(app)
          .post('/api/v1/hl7/receive')
          .set('x-api-key', LEGACY_RATE_KEY)
          .set('x-forwarded-for', '198.51.100.20')
          .send({
            message: `MSH|^~\\&|EXT|SRC|VH|LIVE|20260806103045+0530||ADT^A01|LIVE-${attempt}|P|2.5`,
          }));
      }
      expectRawAck(responses[0], 401, 'AR');
      expectRawAck(responses[1], 401, 'AR');
      expectJson(responses[2], 429, {
        success: false,
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please try again later.',
      });
    } finally {
      RATE_LIMIT_PROFILES.default.max = previousDefaultMax;
    }
  });

  test('uses the same limiter for recovery but converts only its 429 response to ACK', async () => {
    RATE_LIMIT_PROFILES.default.max = 2;
    try {
      const responses = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        responses.push(await request(app)
          .post('/api/v1/hl7/receive')
          .set('x-api-key', RECOVERY_RATE_KEY)
          .set('x-forwarded-for', '198.51.100.21')
          .send({
            message: `MSH|^~\\&|EXT|SRC|VH|RECOVERY|20260806103045+0530||ADT^A01|RECOVERY-${attempt}|P|2.5`,
            recovery: null,
          }));
      }
      expectRawAck(responses[0], 400, 'AR');
      expectRawAck(responses[1], 400, 'AR');
      expectRawAck(responses[2], 429, 'AE');
    } finally {
      RATE_LIMIT_PROFILES.default.max = previousDefaultMax;
    }
  });

  test('persists the route audit outcome without request body or HL7 message bytes', async () => {
    const sentinel = `HL7-PHI-SENTINEL-${randomUUID()}`;
    const userAgent = `${AUDIT_AGENT_PREFIX}-${randomUUID()}`;
    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('x-forwarded-for', '198.51.100.22')
      .set('user-agent', userAgent)
      .send({
        message: `MSH|^~\\&|EXT|SRC|VH|AUDIT|20260806103045+0530||ADT^A01|${sentinel}|P|2.5`,
        recovery: null,
      });

    expect(response.status).toBe(400);
    const audit = await waitForAuditRow(userAgent);
    expect(audit.request_summary).toBeNull();
    expect(JSON.stringify(audit.metadata)).not.toContain(sentinel);
    expect(JSON.stringify(audit.metadata)).not.toContain('message');
  }, 30_000);
});
