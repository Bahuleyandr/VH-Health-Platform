// chatbotController.triage must thread tenantRegion / tenantId / patientUid
// into triageSymptoms — previously tenantRegion was never passed, which made
// the CHATBOT_EXTERNAL_REGIONS guard all-or-nothing (any configured allowlist
// blocked every call).

import { jest } from '@jest/globals';

const triageSymptoms = jest.fn(async () => ({ triage: 'self_care' }));
jest.unstable_mockModule('../../services/chatbot/triageService.js', () => ({
  triageSymptoms,
  default: { triageSymptoms },
}));

const queryRawUnsafe = jest.fn(async () => [{ id: 7, gender: 'F', birthday: null, allergies: [] }]);
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const successHelper = jest.fn();
const errorHelper = jest.fn();
jest.unstable_mockModule('../../utils/responseHelper.js', () => ({
  success: successHelper,
  error: errorHelper,
}));

const { triage } = await import('../../controllers/chatbot/chatbotController.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafe.mockResolvedValue([{ id: 7, gender: 'F', birthday: null, allergies: [] }]);
  triageSymptoms.mockResolvedValue({ triage: 'self_care' });
});

test('passes tenantRegion, tenantId, and patientUid through to triageSymptoms', async () => {
  const req = {
    body: { symptoms: 'headache for two days', history: [] },
    user: { uid: '30000000-0000-4000-8000-000000000004' },
    tenantId: '20000000-0000-4000-8000-000000000009',
    tenant: { region: 'IN' },
  };
  await triage(req, {});

  expect(triageSymptoms).toHaveBeenCalledWith(expect.objectContaining({
    symptoms: 'headache for two days',
    tenantRegion: 'IN',
    tenantId: '20000000-0000-4000-8000-000000000009',
    patientUid: '30000000-0000-4000-8000-000000000004',
  }));
  expect(queryRawUnsafe).toHaveBeenCalledWith(
    expect.stringContaining('u.uid = $1::uuid'),
    '30000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000009',
  );
  expect(successHelper).toHaveBeenCalled();
});

test('defaults tenantRegion/tenantId/patientUid to null when the request carries none', async () => {
  const req = { body: { symptoms: 'headache for two days' }, user: {} };
  await triage(req, {});

  expect(triageSymptoms).toHaveBeenCalledWith(expect.objectContaining({
    tenantRegion: null,
    tenantId: null,
    patientUid: null,
  }));
  expect(queryRawUnsafe).not.toHaveBeenCalled();
});
