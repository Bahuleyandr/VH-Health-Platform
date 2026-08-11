const idempotencyKeyParameter = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  schema: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    pattern: '^[A-Za-z0-9_\\-:.]+$'
  }
};

export const schemas = {};

export const operations = {
  'POST /api/v1/blood-bank/request': {
    parameters: [idempotencyKeyParameter]
  }
};
