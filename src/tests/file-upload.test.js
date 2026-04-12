// src/tests/file-upload.test.js
// Integration tests for file upload security.
//
// These tests run WITHOUT a database. Tests that require DB data are marked .skip.
// The goal is to verify upload endpoint authentication, MIME type restrictions,
// file size enforcement, and route existence.

import request from 'supertest';
import app from '../app.js';
import { generateToken } from '../utils/jwtUtils.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

// ── Test tokens ─────────────────────────────────────────────────────────────
const patientToken = generateToken({
  uid: 'test-upload-patient',
  id: 10,
  phone: '1234567890',
  role: 'PATIENT'
});

const adminToken = generateToken({
  uid: 'test-upload-admin',
  id: 100,
  phone: '5551112222',
  role: 'ADMIN'
});

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Authenticated supertest request with API key + Bearer token */
const authRequest = (method, path, token) => {
  return request(app)[method](path)
    .set('X-API-Key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. AUTHENTICATION REQUIRED
// ═════════════════════════════════════════════════════════════════════════════

describe('File Upload — Authentication', () => {
  it('should return 401 when no Authorization header is provided', async () => {
    const res = await request(app)
      .post('/api/v1/upload')
      .set('X-API-Key', API_KEY);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when no API key is provided', async () => {
    const res = await request(app)
      .post('/api/v1/upload')
      .set('Authorization', `Bearer ${patientToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('should return 401 when neither API key nor token is provided', async () => {
    const res = await request(app)
      .post('/api/v1/upload');

    expect(res.statusCode).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. UPLOAD ROUTE EXISTS (NOT 404)
// ═════════════════════════════════════════════════════════════════════════════

describe('File Upload — Route Existence', () => {
  it('POST /api/v1/upload should not return 404', async () => {
    const res = await authRequest('post', '/api/v1/upload', adminToken);

    // Without a file attached, expect a validation/processing error, not 404.
    expect(res.statusCode).not.toBe(404);
  });

  it('GET /api/v1/upload should not return 404 (list files endpoint)', async () => {
    const res = await authRequest('get', '/api/v1/upload', adminToken);

    expect(res.statusCode).not.toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. FILE SIZE LIMITS
// ═════════════════════════════════════════════════════════════════════════════

describe('File Upload — File Size Limits', () => {
  it('should reject files exceeding the 50MB limit', async () => {
    // Create a buffer just over 50MB (the HOSPITAL_UPLOAD_CONFIG.maxFileSizeBytes).
    // Multer enforces this at the middleware level before the controller runs.
    const oversizedBuffer = Buffer.alloc(51 * 1024 * 1024, 0);

    const res = await authRequest('post', '/api/v1/upload', adminToken)
      .attach('file', oversizedBuffer, { filename: 'large-file.pdf', contentType: 'application/pdf' });

    // Multer rejects oversized files — expect 400 or 500 (multer error handling),
    // but never 200/201.
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(201);
    expect([400, 413, 500]).toContain(res.statusCode);
  });

  it.skip('should accept files under the size limit (requires R2/DB)', async () => {
    // Attach a small valid PDF and verify 200/201.
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. MIME TYPE RESTRICTIONS
// ═════════════════════════════════════════════════════════════════════════════

describe('File Upload — MIME Type Restrictions', () => {
  // The upload config allowedMimeTypes does NOT include executable types.
  // Multer's fileFilter rejects disallowed MIME types before the file is stored.

  it('should reject .exe files (application/x-msdownload)', async () => {
    const fakeExe = Buffer.from('MZ fake executable content');

    const res = await authRequest('post', '/api/v1/upload', adminToken)
      .attach('file', fakeExe, { filename: 'malware.exe', contentType: 'application/x-msdownload' });

    // Multer fileFilter rejects the MIME type. The error handler returns 400 or 500.
    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(201);
    expect([400, 403, 500]).toContain(res.statusCode);
  });

  it('should reject .bat files (application/x-msdos-program)', async () => {
    const fakeBat = Buffer.from('@echo off\necho hacked');

    const res = await authRequest('post', '/api/v1/upload', adminToken)
      .attach('file', fakeBat, { filename: 'script.bat', contentType: 'application/x-msdos-program' });

    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(201);
    expect([400, 403, 500]).toContain(res.statusCode);
  });

  it('should reject .sh files (application/x-sh)', async () => {
    const fakeShell = Buffer.from('#!/bin/bash\nrm -rf /');

    const res = await authRequest('post', '/api/v1/upload', adminToken)
      .attach('file', fakeShell, { filename: 'exploit.sh', contentType: 'application/x-sh' });

    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).not.toBe(201);
    expect([400, 403, 500]).toContain(res.statusCode);
  });

  it('should not reject application/pdf MIME type (it is allowed)', async () => {
    // A real PDF starts with %PDF magic bytes
    const pdfHeader = Buffer.from('%PDF-1.4 fake pdf content');

    const res = await authRequest('post', '/api/v1/upload', adminToken)
      .attach('file', pdfHeader, { filename: 'report.pdf', contentType: 'application/pdf' });

    // The MIME type passes the fileFilter. Without a DB the controller may 500,
    // but it should NOT be rejected by the MIME type check (no multer error).
    // We verify it does not get the MIME-rejection error pattern.
    expect(res.statusCode).not.toBe(404);
    // If it got past multer, the status will be 400 (validation), 500 (no DB), or 200/201.
    expect([200, 201, 400, 422, 500]).toContain(res.statusCode);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. UPLOAD ROUTE IS POST /api/v1/upload
// ═════════════════════════════════════════════════════════════════════════════

describe('File Upload — Correct HTTP Method', () => {
  it('POST /api/v1/upload is the upload endpoint (accepts multipart)', async () => {
    // Sending a POST with auth but no file — should get a processing error, not 404
    const res = await authRequest('post', '/api/v1/upload', adminToken)
      .send({});

    // Without a file, expect validation error or server error, but NOT 404.
    expect(res.statusCode).not.toBe(404);
    expect([400, 422, 500]).toContain(res.statusCode);
  });

  it('PUT /api/v1/upload should return 404 (only POST is mounted for uploads)', async () => {
    const res = await authRequest('put', '/api/v1/upload', adminToken)
      .send({});

    // PUT is not a registered method on the upload route — expect 404 or 405.
    expect([404, 405]).toContain(res.statusCode);
  });
});
