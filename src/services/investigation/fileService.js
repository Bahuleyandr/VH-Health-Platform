// services/investigation/fileService.js
// Migrated from raw pg to Prisma ORM

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads/investigations';
const ALLOWED_FILE_TYPES = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

async function ensureUploadDir() {
  try {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
  } catch (err) {
    logger.error('Failed to create upload directory:', err);
  }
}

export const uploadInvestigationFile = async (investigationId, file, uploadedBy) => {
  await ensureUploadDir();

  const fileExt = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_FILE_TYPES.includes(fileExt)) {
    throw new Error('Invalid file type. Allowed types: ' + ALLOWED_FILE_TYPES.join(', '));
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error('File size exceeds 10MB limit');
  }

  // Check if investigation exists
  const rows = await prisma.$queryRaw`
    SELECT id FROM investigations WHERE id = ${parseInt(investigationId)}
  `;
  if (rows.length === 0) throw new Error('Investigation not found');

  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const fileName = `inv_${investigationId}_${timestamp}_${randomString}${fileExt}`;
  const filePath = path.join(UPLOAD_DIR, fileName);

  try {
    await fs.writeFile(filePath, file.buffer);

    const result = await prisma.investigation_files.create({
      data: {
        investigation_id: parseInt(investigationId),
        file_name: file.originalname,
        file_path: filePath,
        file_type: fileExt,
        file_size: BigInt(file.size),
        uploaded_by: uploadedBy ? uploadedBy : null,
      },
    });

    logger.info(`File uploaded for investigation ${investigationId}: ${fileName}`);
    return result;
  } catch (err) {
    try { await fs.unlink(filePath); } catch {}
    throw err;
  }
};

export const getInvestigationFiles = async (investigationId) => {
  return prisma.investigation_files.findMany({
    where: { investigation_id: parseInt(investigationId) },
    select: {
      id: true, file_name: true, file_type: true,
      file_size: true, created_at: true, uploaded_by: true,
    },
    orderBy: { created_at: 'desc' },
  });
};

export const getFileById = async (fileId) => {
  return prisma.investigation_files.findUnique({
    where: { id: parseInt(fileId) },
    select: {
      id: true, investigation_id: true, file_name: true,
      file_path: true, file_type: true, file_size: true,
      uploaded_by: true, created_at: true,
    },
  });
};

export const deleteFile = async (fileId, deletedBy) => {
  const file = await prisma.investigation_files.findUnique({
    where: { id: parseInt(fileId) },
    select: {
      id: true, investigation_id: true, file_name: true,
      file_path: true, file_type: true, file_size: true,
      uploaded_by: true, created_at: true,
    },
  });

  if (!file) throw new Error('File not found');

  await prisma.investigation_files.delete({ where: { id: parseInt(fileId) } });

  if (file.file_path) {
    try { await fs.unlink(file.file_path); } catch {}
  }

  logger.info(`File deleted: ${file.file_name} by ${deletedBy}`);
  return true;
};

export const getFileStream = async (fileId) => {
  const file = await getFileById(fileId);
  if (!file) throw new Error('File not found');

  try {
    await fs.access(file.file_path);
  } catch {
    throw new Error('File not found on disk');
  }

  return {
    stream: fs.createReadStream(file.file_path),
    fileName: file.file_name,
    fileType: file.file_type,
  };
};
