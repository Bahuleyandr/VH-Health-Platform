import express from 'express';
import request from 'supertest';
import corsMiddleware from '../../middleware/corsMiddleware.js';

const ORIGIN = 'https://admin.vhhealth.app';
const REQUEST_HEADERS = [
  'Idempotency-Key',
  'X-VH-Import-Patient-Uid',
  'X-VH-Import-Source-System',
  'X-VH-Import-Source-Document-Id',
  'X-VH-Import-Source-Facility-Id',
  'X-VH-Import-Authority-Grant-Id',
  'X-VH-Import-Source-Signature-Sha256',
  'X-VH-Import-Payload-Sha256',
  'X-VH-Import-Correction-Item-Id',
  'X-VH-Import-Correction-Manifest-Index',
];

const CLINICAL_IMPORT_POST_PATHS = [
  '/api/v1/documents/import/fhir-bundle',
  '/api/v1/documents/import/ccd',
  '/api/v1/documents/import/reconciliation/11111111-1111-4111-8111-111111111111/retry-request',
  '/api/v1/documents/import/reconciliation/11111111-1111-4111-8111-111111111111/resolve',
];

function buildApp() {
  const app = express();
  app.use(corsMiddleware);
  return app;
}

describe('clinical-import browser CORS preflight', () => {
  test.each(CLINICAL_IMPORT_POST_PATHS)(
    'allows documented authority headers for OPTIONS %s',
    async (path) => {
      const response = await request(buildApp())
        .options(path)
        .set('Origin', ORIGIN)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', REQUEST_HEADERS.join(', '));

      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBe('true');

      const allowedHeaders = new Set(
        response.headers['access-control-allow-headers']
          .split(',')
          .map(header => header.trim().toLowerCase()),
      );
      for (const header of REQUEST_HEADERS) {
        expect(allowedHeaders).toContain(header.toLowerCase());
      }
    },
  );
});
