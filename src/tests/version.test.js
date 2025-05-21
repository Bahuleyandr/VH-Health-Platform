import getClient, { API_KEY, AUTH_TOKEN } from './testClient.js';

describe('Version API', () => {
  it('should return version information', async () => {
    const res = await getClient()
      .get('/api/v1/version')
      .set('x-api-key', API_KEY)
      .set('Authorization', AUTH_TOKEN);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveProperty('version');
  });
});
