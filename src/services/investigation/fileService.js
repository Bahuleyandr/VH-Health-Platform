// services/investigation/fileService.js
import db from '../../config/database.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import logger from '../../logging/logger.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads/investigations';
const ALLOWED_FILE_TYPES = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// Ensure upload directory exists
async function ensureUploadDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  } catch (err) {
    logger.error('Failed to create upload directory:', err);
  }
}

export const uploadInvestigationFile = async (investigationId, file, uploadedBy) => {
  await ensureUploadDir();
  
  // Validate file
  const fileExt = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_FILE_TYPES.includes(fileExt)) {
    throw new Error('Invalid file type. Allowed types: ' + ALLOWED_FILE_TYPES.join(', '));
  }
  
  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size exceeds 10MB limit');
  }
  
  // Check if investigation exists
  const investigationCheck = await db.query(
    'SELECT id FROM investigations WHERE id = $1',
    [investigationId]
  );
  
  if (investigationCheck.rows.length === 0) {
    throw new Error('Investigation not found');
  }
  
  // Generate unique filename
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const fileName = `inv_${investigationId}_${timestamp}_${randomString}${fileExt}`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  
  try {
    // Save file to disk
    await fs.writeFile(filePath, file.buffer);
    
    // Save file record to database
    const result = await db.query(`
      INSERT INTO investigation_files 
      (investigation_id, file_name, file_path, file_type, file_size, uploaded_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      investigationId,
      file.originalname,
      filePath,
      fileExt,
      file.size,
      uploadedBy
    ]);
    
    logger.info(`File uploaded for investigation ${investigationId}: ${fileName}`);
    
    return result.rows[0];
    
  } catch (err) {
    // Clean up file if database save fails
    try {
      await fs.unlink(filePath);
    } catch (unlinkErr) {
      logger.error('Failed to clean up file:', unlinkErr);
    }
    throw err;
  }
};

export const getInvestigationFiles = async (investigationId) => {
  const result = await db.query(`
    SELECT id, file_name, file_type, file_size, uploaded_at, uploaded_by
    FROM investigation_files
    WHERE investigation_id = $1
    ORDER BY uploaded_at DESC
  `, [investigationId]);
  
  return result.rows;
};

export const getFileById = async (fileId) => {
  const result = await db.query(`
    SELECT * FROM investigation_files WHERE id = $1
  `, [fileId]);
  
  if (result.rows.length === 0) {
    return null;
  }
  
  return result.rows[0];
};

export const deleteFile = async (fileId, deletedBy) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    // Get file info
    const fileResult = await client.query(
      'SELECT * FROM investigation_files WHERE id = $1',
      [fileId]
    );
    
    if (fileResult.rows.length === 0) {
      throw new Error('File not found');
    }
    
    const file = fileResult.rows[0];
    
    // Delete from database
    await client.query(
      'DELETE FROM investigation_files WHERE id = $1',
      [fileId]
    );
    
    // Delete physical file
    await fs.unlink(file.file_path);
    
    await client.query('COMMIT');
    
    logger.info(`File deleted: ${file.file_name} by ${deletedBy}`);
    
    return true;
    
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

export const getFileStream = async (fileId) => {
  const file = await getFileById(fileId);
  
  if (!file) {
    throw new Error('File not found');
  }
  
  // Check if file exists on disk
  try {
    await fs.access(file.file_path);
  } catch (err) {
    throw new Error('File not found on disk');
  }
  
  return {
    stream: fs.createReadStream(file.file_path),
    fileName: file.file_name,
    fileType: file.file_type
  };
};