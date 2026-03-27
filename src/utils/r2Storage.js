// src/utils/r2Storage.js

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from '../logging/logger.js';

const { CF_ACCOUNT_ID, CF_R2_BUCKET, CF_R2_URL, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY } =
  process.env;

const R2_AVAILABLE = !!(CF_ACCOUNT_ID && CF_R2_BUCKET && CF_R2_URL && CF_R2_ACCESS_KEY_ID && CF_R2_SECRET_ACCESS_KEY);

if (!R2_AVAILABLE) {
  logger.warn('⚠️ R2 storage not configured — file operations will fail gracefully');
}

let s3Client = null;
if (R2_AVAILABLE) {
  s3Client = new S3Client({
    endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    region: 'auto',
    credentials: {
      accessKeyId: CF_R2_ACCESS_KEY_ID,
      secretAccessKey: CF_R2_SECRET_ACCESS_KEY
    },
    requestHandler: {
      requestTimeout: 30000
    }
  });
}

function ensureR2Available() {
  if (!R2_AVAILABLE) {
    throw new Error('R2 storage is not configured. Set R2 environment variables.');
  }
}

async function withRetry(fn, maxRetries = 2, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      logger.warn(`R2 operation failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms:`, err.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ✅ Upload File to R2
export async function uploadFileToR2(buffer, key, contentType = 'application/octet-stream') {
  ensureR2Available();
  return withRetry(async () => {
    try {
      const command = new PutObjectCommand({
        Bucket: CF_R2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: contentType
      });
      await s3Client.send(command);
      return `${CF_R2_URL}/${key}`;
    } catch (err) {
      logger.error(`❌ Failed to upload ${key}:`, err);
      throw err;
    }
  });
}

// ✅ Get File Buffer from R2
export async function getFileFromR2(key) {
  ensureR2Available();
  return withRetry(async () => {
    try {
      const command = new GetObjectCommand({
        Bucket: CF_R2_BUCKET,
        Key: key
      });
      const response = await s3Client.send(command);
      return response.Body.transformToByteArray();
    } catch (err) {
      logger.error(`❌ Failed to get file ${key}:`, err);
      throw err;
    }
  });
}

// ✅ Delete Object from R2
export async function deleteObject(key) {
  ensureR2Available();
  try {
    const command = new DeleteObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key
    });
    await s3Client.send(command);
  } catch (err) {
    logger.error(`❌ Failed to delete ${key}:`, err);
    throw err;
  }
}

// ✅ List Objects from R2 Bucket
export async function listObjectsV2(continuationToken = undefined) {
  ensureR2Available();
  const command = new ListObjectsV2Command({
    Bucket: CF_R2_BUCKET,
    ContinuationToken: continuationToken
  });
  return await s3Client.send(command);
}

// ✅ Copy Object within R2 Bucket
export async function copyObject(sourceKey, destinationKey) {
  ensureR2Available();
  const command = new CopyObjectCommand({
    Bucket: CF_R2_BUCKET,
    CopySource: `${CF_R2_BUCKET}/${sourceKey}`,
    Key: destinationKey
  });
  return await s3Client.send(command);
}

// ✅ Generate Signed URL for GET access
export async function getSignedFileUrl(key, expiresInSeconds = 3600) {
  ensureR2Available();
  return withRetry(async () => {
    const command = new GetObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key
    });
    return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  });
}
