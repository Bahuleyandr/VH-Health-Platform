import Ajv from 'ajv';
import { operations, schemas } from '../../../scripts/openapi/schemas/hl7.mjs';

const validateFeedError = new Ajv({ strict: false, allErrors: true })
  .compile(schemas.Hl7FeedErrorResponse);

describe('HL7 feed OpenAPI contract', () => {
  it.each([
    { success: false, message: 'name is required', code: 'HL7_FEED_NAME_REQUIRED' },
    { success: false, error: 'Forbidden' },
    { error: 'Missing API Key in request headers' },
    { error: 'Server configuration error' },
  ])('accepts each runtime error envelope: %j', (payload) => {
    expect(validateFeedError(payload)).toBe(true);
  });

  it('does not accept an unrelated success payload as an error', () => {
    expect(validateFeedError({ success: true, data: {} })).toBe(false);
  });

  it('documents the shared runtime error schema on every feed-management operation', () => {
    const feedOperations = Object.entries(operations)
      .filter(([key]) => key.includes('/api/v1/hl7-feeds/'));
    expect(feedOperations).toHaveLength(5);
    for (const [, operation] of feedOperations) {
      for (const response of Object.values(operation.additionalResponses)) {
        expect(response.content['application/json'].schema).toEqual({
          $ref: '#/components/schemas/Hl7FeedErrorResponse',
        });
      }
    }
  });
});
