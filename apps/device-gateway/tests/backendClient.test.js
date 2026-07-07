import { jest } from '@jest/globals';
import { BackendClient } from '../src/backendClient.js';

describe('BackendClient', () => {
  it('sends bearer token and API key headers', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { ok: true } }),
    }));
    const client = new BackendClient({
      baseUrl: 'http://backend',
      token: 'gateway-jwt',
      apiKey: 'gateway-api-key',
      fetchImpl,
    });

    await client.resolveDevice({ source_ip: '10.1.1.5' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://backend/api/v1/devices/vitals/resolve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer gateway-jwt',
          'x-api-key': 'gateway-api-key',
        }),
      }),
    );
  });

  it('sends cold-chain sensor bearer token to the direct backend ingest route', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { action: 'reading_recorded' } }),
    }));
    const client = new BackendClient({
      baseUrl: 'http://backend/',
      token: 'gateway-jwt',
      apiKey: 'gateway-api-key',
      fetchImpl,
    });

    await client.ingestColdChain({ unit_code: 'FRIDGE-1', temp_c: 4.2 }, {
      deviceToken: 'sensor-token',
      tenantId: '00000000-0000-4000-8000-000000000001',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://backend/api/v1/ingest/cold-chain',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sensor-token',
          'x-device-token': 'sensor-token',
          'x-api-key': 'gateway-api-key',
          'x-tenant-id': '00000000-0000-4000-8000-000000000001',
        }),
      }),
    );
  });
});
