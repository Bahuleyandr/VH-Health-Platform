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
});
