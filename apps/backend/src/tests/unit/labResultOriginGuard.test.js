import { jest } from '@jest/globals';
import { LAB_RESULT_ORIGIN_FIELDS, rejectLabResultOriginFields } from '../../middleware/labResultOriginGuard.js';

// responseHelper.error() writes through res.status().json() and reads res.req
// for the request id, so the fake carries both.
function res() {
  const r = { statusCode: 200, body: null, req: { id: 'test-req', originalUrl: '/api/v1/lab/results' } };
  r.status = (code) => { r.statusCode = code; return r; };
  r.json = (body) => { r.body = body; return r; };
  return r;
}

describe('rejectLabResultOriginFields', () => {
  test('passes a plain manual result through', () => {
    const next = jest.fn();
    const r = res();
    rejectLabResultOriginFields({ body: { test_code: 'K', value_text: '4.1' } }, r, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(r.statusCode).toBe(200);
  });

  test('passes a request with no body through', () => {
    const next = jest.fn();
    rejectLabResultOriginFields({}, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects result_origin and external fields with 400 and names them', () => {
    const next = jest.fn();
    const r = res();
    rejectLabResultOriginFields(
      { body: { test_code: 'K', result_origin: 'external_lab', external_lab_name: 'X' } },
      r,
      next,
    );
    expect(next).not.toHaveBeenCalled();
    expect(r.statusCode).toBe(400);
    expect(r.body.details).toMatchObject({
      code: 'LAB_RESULT_ORIGIN_NOT_ALLOWED',
      fields: ['result_origin', 'external_lab_name'],
    });
  });

  test('rejects every provenance field, including an explicit null', () => {
    for (const field of LAB_RESULT_ORIGIN_FIELDS) {
      const next = jest.fn();
      const r = res();
      rejectLabResultOriginFields({ body: { [field]: null } }, r, next);
      expect(next).not.toHaveBeenCalled();
      expect(r.statusCode).toBe(400);
    }
  });
});
