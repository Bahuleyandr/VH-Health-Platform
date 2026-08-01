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

  it('reads the landed I09 resume-state route and preserves machine-readable refusal codes', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { contract: 'vhhealth.i09.gateway-sequence/v1' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          success: false,
          message: 'Canonical recovery marker is missing',
          code: 'EXTERNAL_RECOVERY_MARKER_MISSING',
        }),
      });
    const client = new BackendClient({
      baseUrl: 'http://backend', token: 'gateway-jwt', apiKey: 'gateway-api-key', fetchImpl,
    });

    await expect(client.readI09ResumeState({ gatewayRegistryId: 41, deviceRegistryId: 42 }))
      .resolves.toEqual({ contract: 'vhhealth.i09.gateway-sequence/v1' });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://backend/api/v1/devices/vitals/recovery/resume-state?gateway_registry_id=41&device_registry_id=42',
    );
    await expect(client.ingestI09Recovery({ recovery: {} })).rejects.toMatchObject({
      status: 409,
      code: 'EXTERNAL_RECOVERY_MARKER_MISSING',
      ambiguous: false,
    });
  });

  it('uses rotated gateway JWT/API-key material on the next handshake without caching old headers', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: {} }) }));
    const client = new BackendClient({
      baseUrl: 'http://backend', token: 'old-jwt', apiKey: 'old-key', fetchImpl,
    });
    await client.readI09ResumeState({ gatewayRegistryId: 41, deviceRegistryId: 42 });
    client.token = 'new-jwt';
    client.apiKey = 'new-key';
    await client.readI09ResumeState({ gatewayRegistryId: 41, deviceRegistryId: 42 });

    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      authorization: 'Bearer old-jwt', 'x-api-key': 'old-key',
    });
    expect(fetchImpl.mock.calls[1][1].headers).toMatchObject({
      authorization: 'Bearer new-jwt', 'x-api-key': 'new-key',
    });
  });
});
