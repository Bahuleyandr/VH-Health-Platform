import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Re-audit I (tenancy sweep) regression guard.
//
// feedbackService.respondToFeedback INSERTed into `feedback_responses` — a
// table that exists in no migration, is absent from 000_baseline.sql, and has
// no Prisma model. Applying every migration to a clean database leaves
// to_regclass('public.feedback_responses') NULL, so POST
// /api/v1/feedback/respond always raised 42P01 and the staff answer to an
// Ask-a-Doubt question was never stored. There was no read side anywhere, so
// the write path and its route were removed rather than backfilled with a
// table nothing renders.
//
// These tests pin the removal in both directions: the endpoint must stay
// unrouted, and no service/controller/route SQL may name the phantom table
// again.

const here = path.dirname(fileURLToPath(import.meta.url));
const backendSrc = path.resolve(here, '../..');

jest.unstable_mockModule('../../services/feedback/npsService.js', () => ({
  submitNpsResponse: jest.fn(async () => ({ response: {} })),
}));
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorFilterId: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  DEFAULT_TENANT_ID: '00000000-0000-4000-8000-000000000001',
}));
jest.unstable_mockModule('../../utils/resolveIdentity.js', () => ({
  resolvePhoneFromUID: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  dynamicRoleRateLimiter: (_req, _res, next) => next(),
  getRateLimiter: () => (_req, _res, next) => next(),
}));

const { default: feedbackRoutes } = await import('../../routes/feedbackRoutes.js');
const { default: feedbackService } = await import('../../services/feedback/feedbackService.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    id: 7,
    role: 'DOCTOR',
    phone: '+919876543210',
    name: 'Test Doctor',
  };
  next();
});
app.use('/api/v1/feedback', feedbackRoutes);

// Deliberately narrow: only the layers that issue SQL. Test fixtures and the
// re-audit comments that explain the removal are allowed to name the table.
const SQL_LAYER_DIRS = ['services', 'controllers', 'routes'];

function collectJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, acc);
    else if (entry.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('feedback staff-reply path stays removed', () => {
  test('POST /api/v1/feedback/respond is not routed', async () => {
    const response = await request(app)
      .post('/api/v1/feedback/respond')
      .send({ feedback_id: 1, response: 'We are looking into it' });

    expect(response.statusCode).toBe(404);
  });

  test('feedbackService exposes neither respondToFeedback nor its dead lookup helper', () => {
    expect(typeof feedbackService.respondToFeedback).toBe('undefined');
    expect(typeof feedbackService.getFeedbackById).toBe('undefined');
  });

  test('no service/controller/route code names the phantom feedback_responses table', () => {
    const offenders = [];
    for (const dirName of SQL_LAYER_DIRS) {
      const dir = path.join(backendSrc, dirName);
      for (const file of collectJsFiles(dir)) {
        if (stripComments(fs.readFileSync(file, 'utf8')).includes('feedback_responses')) {
          offenders.push(path.relative(backendSrc, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
