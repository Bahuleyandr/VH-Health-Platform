// src/utils/fileProcessingUtils.js - Hospital File Processing Utilities

import { exec } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { HOSPITAL_UPLOAD_CONFIG } from '../config/uploadConfig.js';
import logger from '../logging/logger.js';

export function generateSecureFileKey(originalName, category = 'general', patientPhone = null) {
  const timestamp = Date.now();
  const random = crypto.randomBytes(16).toString('hex');
  const ext = path.extname(originalName).toLowerCase();
  const sanitizedCategory = category.replace(/[^a-zA-Z0-9_-]/g, '');
  
  let keyPath = `hospital/${sanitizedCategory}/${timestamp}_${random}${ext}`;
  
  // Add patient identifier for medical records (hashed for privacy)
  if (patientPhone && HOSPITAL_UPLOAD_CONFIG.hipaaCategories.includes(category)) {
    const patientHash = crypto.createHash('sha256').update(patientPhone).digest('hex').substring(0, 8);
    keyPath = `hospital/${sanitizedCategory}/patient_${patientHash}/${timestamp}_${random}${ext}`;
  }
  
  return keyPath;
}

export async function optimizeImage(buffer, mimetype, isHipaaProtected = false) {
  try {
    let processor = sharp(buffer);
    const metadata = await processor.metadata();
    
    // Higher quality for HIPAA protected medical images
    const quality = isHipaaProtected ? 98 : HOSPITAL_UPLOAD_CONFIG.imageQuality;
    const maxWidth = isHipaaProtected ? 8192 : HOSPITAL_UPLOAD_CONFIG.imageMaxWidth;
    const maxHeight = isHipaaProtected ? 8192 : HOSPITAL_UPLOAD_CONFIG.imageMaxHeight;
    
    // Resize if too large
    if (metadata.width > maxWidth || metadata.height > maxHeight) {
      processor = processor.resize(maxWidth, maxHeight, { 
        fit: 'inside', 
        withoutEnlargement: false 
      });
    }
    
    // Format-specific optimization
    if (mimetype === 'image/jpeg' || mimetype === 'image/jpg') {
      return await processor.jpeg({ quality, progressive: true }).toBuffer();
    } else if (mimetype === 'image/png') {
      return await processor.png({ 
        compressionLevel: isHipaaProtected ? 6 : 8,
        quality
      }).toBuffer();
    } else if (mimetype === 'image/webp') {
      return await processor.webp({ quality }).toBuffer();
    }
    
    return buffer;
  } catch (err) {
    logger.warn('Image optimization failed, using original:', err.message);
    return buffer;
  }
}

export async function compressPDF(buffer, isHipaaProtected = false) {
  try {
    const tempIn = `/tmp/${Date.now()}_${crypto.randomBytes(8).toString('hex')}_in.pdf`;
    const tempOut = `/tmp/${Date.now()}_${crypto.randomBytes(8).toString('hex')}_out.pdf`;

    await fs.writeFile(tempIn, buffer);

    // Higher quality settings for HIPAA protected documents
    const pdfSettings = isHipaaProtected ? '/prepress' : '/ebook';

    await new Promise((resolve, reject) => {
      exec(
        `gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=${pdfSettings} -dNOPAUSE -dQUIET -dBATCH -sOutputFile=${tempOut} ${tempIn}`,
        { timeout: 30000 }, // 30 second timeout
        (err) => (err ? reject(err) : resolve())
      );
    });

    const compressedBuffer = await fs.readFile(tempOut);
    
    // Cleanup temp files
    await Promise.all([
      fs.unlink(tempIn).catch(() => {}),
      fs.unlink(tempOut).catch(() => {})
    ]);

    // Only return compressed if it's actually smaller or same quality needed
    return compressedBuffer.length < buffer.length || isHipaaProtected 
      ? compressedBuffer 
      : buffer;
  } catch (err) {
    logger.warn('PDF compression failed, using original:', err.message);
    return buffer;
  }
}

export function calculateRetentionDate(category) {
  const retentionDays = HOSPITAL_UPLOAD_CONFIG.retentionPeriods[category] || 
                       HOSPITAL_UPLOAD_CONFIG.retentionPeriods.default;
  const retentionDate = new Date();
  retentionDate.setDate(retentionDate.getDate() + retentionDays);
  return retentionDate;
}

export function formatFileResponse(file) {
  return {
    ...file,
    uploadedAt: file.uploaded_at?.toISOString(),
    uploadedAtFormatted: file.uploaded_at?.toLocaleDateString('en-GB'),
    scannedAt: file.scanned_at?.toISOString(),
    scannedAtFormatted: file.scanned_at?.toLocaleDateString('en-GB'),
    retentionDate: file.retention_date?.toISOString()?.split('T')[0],
    retentionDateFormatted: file.retention_date?.toLocaleDateString('en-GB'),
    quarantinedAt: file.quarantined_at?.toISOString(),
    quarantinedAtFormatted: file.quarantined_at?.toLocaleDateString('en-GB'),
    fileSizeMB: (file.file_size / 1024 / 1024).toFixed(2),
    originalSizeMB: file.original_size ? (file.original_size / 1024 / 1024).toFixed(2) : null,
    compressionSavings: file.compression_applied && file.original_size > file.file_size
      ? `${(((file.original_size - file.file_size) / file.original_size) * 100).toFixed(1)}%`
      : null,
    daysUntilExpiry: file.retention_date 
      ? Math.ceil((new Date(file.retention_date) - new Date()) / (1000 * 60 * 60 * 24))
      : null
  };
}