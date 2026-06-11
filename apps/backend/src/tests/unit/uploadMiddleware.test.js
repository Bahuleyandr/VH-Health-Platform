import { jest } from '@jest/globals';

import {
  normalizeUploadMimeType,
  validateFileContent,
  validateGenericDocumentUpload,
  validatePatientUpload,
} from '../../middleware/uploadMiddleware.js';

function runMiddleware(middleware, req) {
  const res = {
    status: jest.fn(() => res),
    json: jest.fn(() => res),
  };
  const next = jest.fn();

  middleware(req, res, next);

  return { res, next };
}

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PDF_BYTES = Buffer.from('%PDF-1.7\n');
const WAV_BYTES = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ');

describe('uploadMiddleware.normalizeUploadMimeType', () => {
  it('normalizes Windows octet-stream JPG uploads from the filename extension', () => {
    const file = {
      originalname: 'patient-slip.JPG',
      mimetype: 'application/octet-stream',
    };

    expect(normalizeUploadMimeType(file)).toBe('image/jpeg');
    expect(file.mimetype).toBe('image/jpeg');
  });

  it('preserves non-fallback MIME declarations', () => {
    const file = {
      originalname: 'patient-slip.jpg',
      mimetype: 'text/plain',
    };

    expect(normalizeUploadMimeType(file)).toBe('text/plain');
    expect(file.mimetype).toBe('text/plain');
  });

  it('infers octet-stream uploads from magic bytes when the picker does not provide a useful filename', () => {
    const file = {
      originalname: 'upload',
      mimetype: 'application/octet-stream',
      buffer: PNG_BYTES,
    };

    expect(normalizeUploadMimeType(file)).toBe('image/png');
    expect(file.mimetype).toBe('image/png');
  });
});

describe('uploadMiddleware patient file validation', () => {
  it('accepts Android octet-stream patient images when filename and content agree', () => {
    const req = {
      file: {
        originalname: 'patient-slip.jpg',
        mimetype: 'application/octet-stream',
        buffer: JPEG_BYTES,
        size: JPEG_BYTES.length,
      },
    };

    const contentValidation = runMiddleware(validateFileContent, req);
    expect(contentValidation.next).toHaveBeenCalledTimes(1);
    expect(contentValidation.res.status).not.toHaveBeenCalled();

    const patientValidation = runMiddleware(validatePatientUpload, req);
    expect(patientValidation.next).toHaveBeenCalledTimes(1);
    expect(patientValidation.res.status).not.toHaveBeenCalled();
    expect(req.file.mimetype).toBe('image/jpeg');
  });

  it('accepts Android octet-stream patient PDFs when filename and content agree', () => {
    const req = {
      file: {
        originalname: 'prescription.pdf',
        mimetype: 'application/octet-stream',
        buffer: PDF_BYTES,
        size: PDF_BYTES.length,
      },
    };

    const contentValidation = runMiddleware(validateFileContent, req);
    expect(contentValidation.next).toHaveBeenCalledTimes(1);

    const patientValidation = runMiddleware(validatePatientUpload, req);
    expect(patientValidation.next).toHaveBeenCalledTimes(1);
    expect(req.file.mimetype).toBe('application/pdf');
  });

  it('rejects octet-stream uploads when extension and file content disagree', () => {
    const req = {
      file: {
        originalname: 'patient-slip.jpg',
        mimetype: 'application/octet-stream',
        buffer: PDF_BYTES,
        size: PDF_BYTES.length,
      },
    };

    const contentValidation = runMiddleware(validateFileContent, req);
    expect(contentValidation.next).not.toHaveBeenCalled();
    expect(contentValidation.res.status).toHaveBeenCalledWith(400);
    expect(contentValidation.res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'INVALID_FILE_CONTENT' }),
    );
  });

  it('does not misclassify RIFF/WAV files as WebP during general content validation', () => {
    const req = {
      file: {
        originalname: 'visit-audio.wav',
        mimetype: 'audio/wav',
        buffer: WAV_BYTES,
        size: WAV_BYTES.length,
      },
    };

    const contentValidation = runMiddleware(validateFileContent, req);
    expect(contentValidation.next).toHaveBeenCalledTimes(1);
    expect(contentValidation.res.status).not.toHaveBeenCalled();
  });
});

describe('uploadMiddleware generic document validation', () => {
  it('allows investigation document uploads with normalized DOCX metadata', () => {
    const req = {
      file: {
        originalname: 'external-report.docx',
        mimetype: 'application/octet-stream',
        buffer: Buffer.from('PK\x03\x04docx-ish'),
        size: 64,
      },
    };

    const contentValidation = runMiddleware(validateFileContent, req);
    expect(contentValidation.next).toHaveBeenCalledTimes(1);

    const genericValidation = runMiddleware(validateGenericDocumentUpload, req);
    expect(genericValidation.next).toHaveBeenCalledTimes(1);
    expect(genericValidation.res.status).not.toHaveBeenCalled();
    expect(req.file.mimetype).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('rejects active text and SVG formats after content validation', () => {
    const htmlReq = {
      file: {
        originalname: 'label.html',
        mimetype: 'text/html',
        buffer: Buffer.from('<!doctype html><script>alert(1)</script>'),
        size: 45,
      },
    };

    const htmlContentValidation = runMiddleware(validateFileContent, htmlReq);
    expect(htmlContentValidation.next).toHaveBeenCalledTimes(1);

    const htmlGenericValidation = runMiddleware(validateGenericDocumentUpload, htmlReq);
    expect(htmlGenericValidation.next).not.toHaveBeenCalled();
    expect(htmlGenericValidation.res.status).toHaveBeenCalledWith(400);

    const svgReq = {
      file: {
        originalname: 'payload.svg',
        mimetype: 'image/svg+xml',
        buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
        size: 29,
      },
    };

    const svgContentValidation = runMiddleware(validateFileContent, svgReq);
    expect(svgContentValidation.next).toHaveBeenCalledTimes(1);

    const svgGenericValidation = runMiddleware(validateGenericDocumentUpload, svgReq);
    expect(svgGenericValidation.next).not.toHaveBeenCalled();
    expect(svgGenericValidation.res.status).toHaveBeenCalledWith(400);
  });
});
