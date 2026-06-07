import { normalizeUploadMimeType } from '../../middleware/uploadMiddleware.js';

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
});
