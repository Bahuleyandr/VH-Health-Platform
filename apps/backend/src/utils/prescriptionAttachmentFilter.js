import { AppError } from './AppError.js';

export const PRESCRIPTION_ATTACHMENT_ERROR_CODE = 'INVALID_PRESCRIPTION_ATTACHMENT';
export const PRESCRIPTION_ATTACHMENT_ERROR_MESSAGE = 'Only images and PDFs are allowed';
export const PRESCRIPTION_ATTACHMENT_ACCEPTED_TYPES = ['image/*', 'application/pdf'];

export function isAllowedPrescriptionAttachment(file) {
  const mimetype = file?.mimetype || '';
  return mimetype.startsWith('image/') || mimetype === 'application/pdf';
}

export function createInvalidPrescriptionAttachmentError() {
  return AppError.badRequest(
    PRESCRIPTION_ATTACHMENT_ERROR_MESSAGE,
    PRESCRIPTION_ATTACHMENT_ERROR_CODE,
    { acceptedTypes: PRESCRIPTION_ATTACHMENT_ACCEPTED_TYPES }
  );
}

export function prescriptionAttachmentFileFilter(_req, file, cb) {
  if (isAllowedPrescriptionAttachment(file)) {
    cb(null, true);
    return;
  }
  cb(createInvalidPrescriptionAttachmentError());
}
