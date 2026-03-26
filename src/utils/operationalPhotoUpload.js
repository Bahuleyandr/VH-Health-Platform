/**
 * Operational Photo Upload Helper
 * Lightweight upload for non-medical photos (housekeeping, incidents, grievances).
 * - Compresses to 1280px max / 72% quality before upload (vs 4096px / 95% for medical)
 * - Stores only R2 key in DB — URL is generated on demand via signed URL
 * - Retention enforced by purge jobs (90 days housekeeping, 1 year incidents/grievances)
 */

import crypto from 'crypto';
import sharp from 'sharp';
import logger from '../logging/logger.js';
import { uploadFileToR2 } from './r2Storage.js';
import { HOSPITAL_UPLOAD_CONFIG } from '../config/uploadConfig.js';

const MAX_WIDTH  = HOSPITAL_UPLOAD_CONFIG.operationalImageMaxWidth  || 1280;
const MAX_HEIGHT = HOSPITAL_UPLOAD_CONFIG.operationalImageMaxHeight || 1280;
const QUALITY    = HOSPITAL_UPLOAD_CONFIG.operationalImageQuality   || 72;

/**
 * Compress and upload an operational photo buffer to R2.
 *
 * @param {Buffer} buffer      Raw image buffer
 * @param {string} category    'housekeeping_log' | 'housekeeping_request' | 'incident_photo' | 'grievance_evidence'
 * @param {string} mimeType    e.g. 'image/jpeg'
 * @returns {{ key: string, sizeKb: number, originalSizeKb: number }} R2 key + size info
 */
export async function uploadOperationalPhoto(buffer, category, mimeType = 'image/jpeg') {
  const originalSizeKb = Math.round(buffer.length / 1024);

  // Compress via sharp
  let compressed;
  try {
    const processor = sharp(buffer);
    const meta = await processor.metadata();

    let pipe = processor;
    if ((meta.width || 0) > MAX_WIDTH || (meta.height || 0) > MAX_HEIGHT) {
      pipe = pipe.resize(MAX_WIDTH, MAX_HEIGHT, { fit: 'inside', withoutEnlargement: false });
    }

    if (mimeType === 'image/png') {
      compressed = await pipe.png({ compressionLevel: 8, quality: QUALITY }).toBuffer();
    } else if (mimeType === 'image/webp') {
      compressed = await pipe.webp({ quality: QUALITY }).toBuffer();
    } else {
      // Default to JPEG (most camera photos are JPEG)
      compressed = await pipe.jpeg({ quality: QUALITY, progressive: true }).toBuffer();
    }
  } catch (e) {
    logger.warn(`Operational photo compression failed, using original: ${e.message}`);
    compressed = buffer;
  }

  const compressedSizeKb = Math.round(compressed.length / 1024);
  const savings = originalSizeKb > 0
    ? Math.round((1 - compressedSizeKb / originalSizeKb) * 100)
    : 0;

  // Generate R2 key
  const ts = Date.now();
  const rand = crypto.randomBytes(8).toString('hex');
  const ext = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
  const key = `operational/${category}/${ts}_${rand}${ext}`;

  await uploadFileToR2(compressed, key, mimeType === 'image/png' ? 'image/png' : 'image/jpeg');

  logger.info(`📸 Operational photo uploaded: ${key} (${originalSizeKb}KB → ${compressedSizeKb}KB, ${savings}% saved)`);

  return {
    key,
    sizeKb: compressedSizeKb,
    originalSizeKb,
    savingsPct: savings,
  };
}
