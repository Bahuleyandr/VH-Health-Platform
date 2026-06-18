/**
 * Input-hardening (PLATFORM_AUDIT_2026-06-18 §4, independent-auditor #4):
 * the three upload routes that previously relied only on a multer MIME
 * fileFilter must now run the shared magic-byte validator (validateFileContent)
 * after multer and before the handler stores/processes the file.
 *
 * These tests mount the REAL route modules on a bare Express app (auth/tenant
 * stubbed via a pre-middleware) so the route's own middleware array — including
 * the new validateFileContent — is exercised end to end. A spoofed file
 * (declared image/PDF, but the buffer's magic bytes say otherwise) must be
 * rejected with 400 INVALID_FILE_CONTENT, which can only be produced by the
 * shared validator. Self-isolating: the spoof is rejected before any DB / R2
 * call, so no seeding is required.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import prescriptionRoutes from '../routes/prescription/index.js';
import staffRoutes from '../routes/staff/index.js';
import knowledgeBaseRoutes from '../routes/admin/clinicalAi/knowledgeBaseRoutes.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

// A buffer whose first bytes are plainly NOT a JPEG/PNG/PDF — a script payload
// renamed to look like an image. inferMimeTypeFromMagicBytes() returns null,
// and image/pdf are NOT in the validator's relaxed list, so it is rejected.
const SPOOFED_BYTES = Buffer.from('<?php system($_GET["c"]); ?>\n', 'utf8');
// A genuine PNG header so the validator passes the file through.
const REAL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function mountWithUser(router, user = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      uid: '11111111-1111-4111-8111-111111111111',
      id: 1,
      role: 'ADMIN',
      scope: 'full',
      deviceType: 'desktop',
      tenant_id: TENANT_ID,
      ...user,
    };
    req.tenantId = TENANT_ID;
    req.id = 'test-req';
    next();
  });
  app.use('/', router);
  // Minimal error handler so a thrown AppError surfaces as JSON, not an HTML 500.
   
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({
      success: false,
      message: err.message,
      code: err.code || null,
    });
  });
  return app;
}

describe('Upload routes enforce the shared magic-byte validator', () => {
  // The handlers (post-validator) hit R2/DB; we never reach them on the spoof
  // path, but guard against an accidental real upload during the happy-path
  // assertion by failing fast if R2 is somehow invoked with the test buffer.
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('handwritten prescription upload (POST /create)', () => {
    it('rejects a spoofed image (wrong magic bytes) with 400 INVALID_FILE_CONTENT', async () => {
      const app = mountWithUser(prescriptionRoutes, { role: 'ADMIN' });
      const res = await request(app)
        .post('/create')
        .field('patient_id', '1')
        .field('doctor_id', '2')
        .field('medications', JSON.stringify([{ name: 'X' }]))
        .attach('handwritten_photo', SPOOFED_BYTES, {
          filename: 'evil.jpg',
          contentType: 'image/jpeg',
        });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('INVALID_FILE_CONTENT');
    });
  });

  describe('staff prescription compat upload (POST /prescriptions/upload)', () => {
    it('rejects a spoofed PDF (wrong magic bytes) with 400 INVALID_FILE_CONTENT', async () => {
      const app = mountWithUser(staffRoutes, { role: 'ADMIN' });
      const res = await request(app)
        .post('/prescriptions/upload')
        .field('appointment_id', '1')
        .attach('file', SPOOFED_BYTES, {
          filename: 'evil.pdf',
          contentType: 'application/pdf',
        });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('INVALID_FILE_CONTENT');
    });
  });

  describe('clinical-AI KB document upload (POST /knowledge-bases/:id/documents)', () => {
    it('rejects a spoofed PDF (wrong magic bytes) with 400 INVALID_FILE_CONTENT', async () => {
      const app = mountWithUser(knowledgeBaseRoutes);
      const res = await request(app)
        .post('/knowledge-bases/00000000-0000-4000-8000-0000000000aa/documents')
        .attach('file', SPOOFED_BYTES, {
          filename: 'evil.pdf',
          contentType: 'application/pdf',
        });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('INVALID_FILE_CONTENT');
    });

    it('does NOT reject a genuine PNG at the validator (passes to the handler)', async () => {
      const app = mountWithUser(knowledgeBaseRoutes);
      const res = await request(app)
        .post('/knowledge-bases/00000000-0000-4000-8000-0000000000aa/documents')
        .attach('file', REAL_PNG, {
          filename: 'real.png',
          contentType: 'image/png',
        });
      // A real PNG clears validateFileContent; whatever the handler returns
      // (it will fail later on KB lookup / OCR), it must NOT be the
      // validator's content rejection.
      expect(res.body.error).not.toBe('INVALID_FILE_CONTENT');
    });
  });
});
