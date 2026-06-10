import { jest } from '@jest/globals';

import {
  createWhoIcdClient,
  extractIcdEntityId,
  resetWhoIcdTokenCache,
} from '../../services/terminology/whoIcdClient.js';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe('WHO ICD client', () => {
  beforeEach(() => {
    resetWhoIcdTokenCache();
  });

  test('caches OAuth token and normalizes ICD-11 MMS search results', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'tok-1', expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse(200, {
        destinationEntities: [{
          id: 'http://id.who.int/icd/release/11/2026-01/mms/123',
          theCode: 'BA00',
          title: 'Essential <em class="found">hypertension</em>',
          chapter: '11',
          score: 1,
          important: true,
          isLeaf: true,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        destinationEntities: [{
          id: 'http://id.who.int/icd/release/11/2026-01/mms/456',
          theCode: 'BA01',
          title: 'Secondary hypertension',
          chapter: '11',
          score: 0.8,
        }],
      }));
    const client = createWhoIcdClient({
      fetchImpl,
      env: {
        WHO_ICD_CLIENT_ID: 'client',
        WHO_ICD_CLIENT_SECRET: 'secret',
        WHO_ICD_BASE_URL: 'https://id.who.int',
        WHO_ICD_AUTH_URL: 'https://auth.example/token',
        WHO_ICD_RELEASE_ID: '2026-01',
        WHO_ICD_LANGUAGE: 'en',
      },
      now: () => 1000,
    });

    const first = await client.searchIcd11('hypertension');
    const second = await client.searchIcd11('secondary hypertension');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://auth.example/token');
    expect(first[0]).toMatchObject({
      system_key: 'ICD11',
      code: 'BA00',
      display: 'Essential hypertension',
      release_id: '2026-01',
      language: 'en',
      linearization_uri: 'http://id.who.int/icd/release/11/2026-01/mms/123',
    });
    expect(second[0].code).toBe('BA01');
  });

  test('can run against local WHO ICD deployment without OAuth', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(jsonResponse(200, {
      code: 'BA00',
      stemId: 'http://id.who.int/icd/release/11/2026-01/mms/123',
    })).mockResolvedValueOnce(jsonResponse(200, {
      '@id': 'http://id.who.int/icd/release/11/2026-01/mms/123',
      code: 'BA00',
      title: { '@value': 'Essential hypertension' },
      source: 'http://id.who.int/icd/entity/123',
      classKind: 'category',
    }));
    const client = createWhoIcdClient({
      fetchImpl,
      env: {
        WHO_ICD_DISABLE_AUTH: 'true',
        WHO_ICD_BASE_URL: 'http://127.0.0.1:8080',
        WHO_ICD_RELEASE_ID: '2026-01',
      },
    });

    const concept = await client.lookupIcd11Code('BA00');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(concept).toMatchObject({
      code: 'BA00',
      display: 'Essential hypertension',
      foundation_uri: 'http://id.who.int/icd/entity/123',
    });
  });

  test('extracts entity ids from WHO URIs', () => {
    expect(extractIcdEntityId('http://id.who.int/icd/release/11/2026-01/mms/123')).toBe('123');
    expect(extractIcdEntityId('123')).toBe('123');
    expect(extractIcdEntityId('')).toBeNull();
  });
});
