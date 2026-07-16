import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of the shared
// credentialing handleFailure (previously `err.details ?? { code: err.code }`).

const listPrivilegeCatalogMock = jest.fn();

jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  upload: { single: () => (_req, _res, next) => next() },
  validateFileContent: (_req, _res, next) => next(),
  validateGenericDocumentUpload: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  addCredential: jest.fn(),
  acknowledgeCredentialExpiryAlert: jest.fn(),
  decidePrivilegeApproval: jest.fn(),
  listCredentials: jest.fn(),
  listCredentialExpiryAlerts: jest.fn(),
  updateCredentialStatus: jest.fn(),
  listExpiring: jest.fn(),
  listPrivilegeApprovals: jest.fn(),
  listPrivilegeCatalog: listPrivilegeCatalogMock,
  requestPrivilegeGrant: jest.fn(),
  scanCredentialExpiryAlerts: jest.fn(),
  hasActivePrivilege: jest.fn(),
  uploadCredentialDocument: jest.fn(),
  upsertPrivilegeCatalog: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: credentialingRoutes } = await import('../../routes/staff/credentialingRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/credentials', credentialingRoutes);

beforeEach(() => {
  listPrivilegeCatalogMock.mockReset();
});

describe('credentialing handleFailure relays AppError code + details', () => {
  test('AppError carries code at the root and forwards details', async () => {
    listPrivilegeCatalogMock.mockRejectedValueOnce(AppError.conflict(
      'Privilege key already exists',
      'PRIVILEGE_KEY_DUPLICATE',
      { privilege_key: 'lap-chole' },
    ));

    const response = await request(app).get('/api/v1/credentials/catalog');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PRIVILEGE_KEY_DUPLICATE');
    expect(response.body.details).toEqual({ privilege_key: 'lap-chole' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the generic 500 and never leaks err.message', async () => {
    listPrivilegeCatalogMock.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 127.0.0.1:5433'),
    );

    const response = await request(app).get('/api/v1/credentials/catalog');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list privilege catalog');
    expect(response.body.message).not.toMatch(/ECONNREFUSED/);
  });
});
