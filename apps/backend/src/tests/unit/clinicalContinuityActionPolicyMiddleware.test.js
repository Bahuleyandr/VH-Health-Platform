import { jest } from '@jest/globals';

import {
  clinicalContinuityActionPolicyMiddleware
} from '../../middleware/clinicalContinuityActionPolicyMiddleware.js';

test('is inert by default even when a request carries action headers', async () => {
  const previous = process.env.CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED;
  delete process.env.CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED;
  const next = jest.fn();
  try {
    await clinicalContinuityActionPolicyMiddleware(
      {
        get: name =>
          name.toLowerCase() === 'x-vh-continuity-action-id'
            ? 'unknown.hostile.action'
            : undefined
      },
      {},
      next
    );
    expect(next).toHaveBeenCalledWith();
  } finally {
    if (previous === undefined) {
      delete process.env.CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED;
    } else {
      process.env.CLINICAL_CONTINUITY_ACTION_REGISTRY_ENABLED = previous;
    }
  }
});
