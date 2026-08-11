import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const getKnowledgeBaseMock = jest.fn();
const listRetrievalLogsMock = jest.fn();

jest.unstable_mockModule('../../services/ai/knowledgeBaseService.js', () => ({
  archiveKnowledgeBase: jest.fn(),
  createKnowledgeBase: jest.fn(),
  getKnowledgeBase: getKnowledgeBaseMock,
  grantAccess: jest.fn(),
  listAccessPolicies: jest.fn(),
  listKnowledgeBases: jest.fn(),
  revokeAccess: jest.fn(),
  unarchiveKnowledgeBase: jest.fn(),
  updateKnowledgeBase: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/knowledgeDocumentService.js', () => ({
  createInlineDocument: jest.fn(),
  decideKnowledgeDocument: jest.fn(),
  deleteKnowledgeDocument: jest.fn(),
  getKnowledgeDocument: jest.fn(),
  listKnowledgeDocuments: jest.fn(),
  reindexDocument: jest.fn(),
  uploadDocument: jest.fn(),
}));

jest.unstable_mockModule('../../services/ai/knowledgeRetrievalService.js', () => ({
  listRetrievalLogs: listRetrievalLogsMock,
  retrieveFromKnowledgeBases: jest.fn(),
}));

jest.unstable_mockModule('../../middleware/uploadMiddleware.js', () => ({
  validateFileContent: (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../routes/admin/clinicalAi/audit.js', () => ({
  logClinicalAiAudit: jest.fn(),
}));

const { default: knowledgeBaseRoutes } = await import(
  '../../routes/admin/clinicalAi/knowledgeBaseRoutes.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const app = express();
app.use((req, _res, next) => {
  req.tenantId = TENANT;
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use(knowledgeBaseRoutes);
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({ success: false, message: err.message });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('clinical AI knowledge-base static route reachability', () => {
  it('dispatches retrieval-logs to the log handler instead of the :id handler', async () => {
    listRetrievalLogsMock.mockResolvedValueOnce({ logs: [{ id: 3 }], count: 1 });

    const response = await request(app)
      .get('/knowledge-bases/retrieval-logs')
      .query({ knowledge_base_id: '7', module_key: 'oncology', limit: '25' });

    expect(response.statusCode).toBe(200);
    expect(listRetrievalLogsMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      knowledgeBaseId: '7',
      moduleKey: 'oncology',
      limit: '25',
    });
    expect(getKnowledgeBaseMock).not.toHaveBeenCalled();
  });

  it('preserves dynamic knowledge-base detail lookup', async () => {
    getKnowledgeBaseMock.mockResolvedValueOnce({ id: 42, name: 'Clinical KB' });

    const response = await request(app).get('/knowledge-bases/42');

    expect(response.statusCode).toBe(200);
    expect(getKnowledgeBaseMock).toHaveBeenCalledWith({ tenantId: TENANT, id: '42' });
    expect(listRetrievalLogsMock).not.toHaveBeenCalled();
  });
});
