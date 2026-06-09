import { jest } from '@jest/globals';

import {
  PRESCRIPTION_ATTACHMENT_ERROR_CODE,
  createInvalidPrescriptionAttachmentError,
  isAllowedPrescriptionAttachment,
  prescriptionAttachmentFileFilter,
} from '../../utils/prescriptionAttachmentFilter.js';

describe('prescriptionAttachmentFilter', () => {
  it('allows image and PDF prescription attachments', () => {
    expect(isAllowedPrescriptionAttachment({ mimetype: 'image/jpeg' })).toBe(true);
    expect(isAllowedPrescriptionAttachment({ mimetype: 'image/png' })).toBe(true);
    expect(isAllowedPrescriptionAttachment({ mimetype: 'application/pdf' })).toBe(true);
  });

  it('rejects unsupported attachments as an operational 400 error', () => {
    const error = createInvalidPrescriptionAttachmentError();

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe(PRESCRIPTION_ATTACHMENT_ERROR_CODE);
    expect(error.isOperational).toBe(true);
    expect(error.message).toBe('Only images and PDFs are allowed');
  });

  it('passes the operational error to multer for unsupported file types', () => {
    const cb = jest.fn();

    prescriptionAttachmentFileFilter(null, { mimetype: 'text/plain' }, cb);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({
      statusCode: 400,
      code: PRESCRIPTION_ATTACHMENT_ERROR_CODE,
      isOperational: true,
    });
  });
});
