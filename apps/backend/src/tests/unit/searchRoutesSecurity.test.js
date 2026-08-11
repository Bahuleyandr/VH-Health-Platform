import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const searchUsersMock = jest.fn();
const searchDoctorsMock = jest.fn();
const searchGlobalMock = jest.fn();

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.unstable_mockModule('../../utils/search/searchService.js', () => ({
  searchUsers: searchUsersMock,
  searchDoctors: searchDoctorsMock,
  searchGlobal: searchGlobalMock,
}));

const { default: searchRoutes } = await import('../../routes/searchRoutes.js');

const app = express();
app.use((req, _res, next) => {
  req.user = { role: 'RECEPTIONIST' };
  next();
});
app.use('/api/v1/search', searchRoutes);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('global search route security', () => {
  it('rejects appointment PHI search before invoking any search service', async () => {
    const response = await request(app)
      .get('/api/v1/search')
      .query({ q: 'follow-up', type: 'appointments' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe('Search type must be all, users, or doctors');
    expect(searchUsersMock).not.toHaveBeenCalled();
    expect(searchDoctorsMock).not.toHaveBeenCalled();
    expect(searchGlobalMock).not.toHaveBeenCalled();
  });

  it('preserves supported doctor search behavior', async () => {
    searchDoctorsMock.mockResolvedValueOnce([{ id: 17, name: 'Doctor One' }]);

    const response = await request(app)
      .get('/api/v1/search')
      .query({ q: 'Doctor', type: 'doctors', limit: '5' });

    expect(response.status).toBe(200);
    expect(searchDoctorsMock).toHaveBeenCalledWith(
      'Doctor',
      5,
      expect.objectContaining({
        role: 'RECEPTIONIST',
        tenantId: '00000000-0000-4000-8000-000000000001',
      }),
    );
    expect(response.body.data.results).toEqual([{ id: 17, name: 'Doctor One' }]);
  });
});
