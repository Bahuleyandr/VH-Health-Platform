import request from 'supertest';

// The I03 ingress is authoritative on HL7_INBOUND_ENABLED and fails closed
// when it is not exactly 'true'; declare the interface ON so the raised parser
// ceiling is exercised against a live ingress. The refused-while-off contract
// lives in hl7-inbound-disabled.deep.test.js.
process.env.HL7_INBOUND_ENABLED = 'true';

const previousBodyLimit = process.env.HTTP_BODY_LIMIT;
process.env.HTTP_BODY_LIMIT = '13mb';

const { default: app } = await import('../app.js');
const { API_KEY } = await import('./testClient.js');

function legacyBodyWithRawBytes(rawBytes) {
  const prefix = 'MSH|^~\\&|EXT|SRC|VH|HIGH-LIMIT|20260806103045+0530||ADT^A01|HIGH-LIMIT|P|2.5\rNTE|1||';
  const emptyBody = JSON.stringify({ message: prefix });
  return JSON.stringify({
    message: `${prefix}${'x'.repeat(rawBytes - Buffer.byteLength(emptyBody, 'utf8'))}`,
  });
}

describe('HL7 receive operator body limit', () => {
  afterAll(() => {
    if (previousBodyLimit === undefined) delete process.env.HTTP_BODY_LIMIT;
    else process.env.HTTP_BODY_LIMIT = previousBodyLimit;
  });

  test('does not reduce an operator limit above the recovery encoded ceiling', async () => {
    const rawBody = legacyBodyWithRawBytes(12_100_001);
    expect(Buffer.byteLength(rawBody, 'utf8')).toBe(12_100_001);

    const response = await request(app)
      .post('/api/v1/hl7/receive')
      .set('x-api-key', API_KEY)
      .set('content-type', 'application/json')
      .send(rawBody);

    expect(response.status).toBe(401);
    expect(response.status).not.toBe(413);
    expect(response.headers['content-type']).toContain('application/hl7-v2');
    expect(response.text).toContain('MSA|AR');
  }, 30_000);
});
