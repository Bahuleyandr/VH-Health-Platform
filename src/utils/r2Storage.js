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

if (
  !CF_ACCOUNT_ID ||
  !CF_R2_BUCKET ||
  !CF_R2_URL ||
  !CF_R2_ACCESS_KEY_ID ||
  !CF_R2_SECRET_ACCESS_KEY
) {
  throw new Error('Missing required R2 environment variables');
}

const s3Client = new S3Client({
  endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  region: 'auto',
  credentials: {
    accessKeyId: CF_R2_ACCESS_KEY_ID,
    secretAccessKey: CF_R2_SECRET_ACCESS_KEY
  }
});

// ✅ Upload File to R2
export async function uploadFileToR2(buffer, key, contentType = 'application/octet-stream') {
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
}

// ✅ Get File Buffer from R2
export async function getFileFromR2(key) {
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
}

// ✅ Delete Object from R2
export async function deleteObject(key) {
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
  const command = new ListObjectsV2Command({
    Bucket: CF_R2_BUCKET,
    ContinuationToken: continuationToken
  });
  return await s3Client.send(command);
}

// ✅ Copy Object within R2 Bucket
export async function copyObject(sourceKey, destinationKey) {
  const command = new CopyObjectCommand({
    Bucket: CF_R2_BUCKET,
    CopySource: `${CF_R2_BUCKET}/${sourceKey}`,
    Key: destinationKey
  });
  return await s3Client.send(command);
}

// ✅ Generate Signed URL for GET access
export async function getSignedFileUrl(key, expiresInSeconds = 3600) {
  const command = new GetObjectCommand({
    Bucket: CF_R2_BUCKET,
    Key: key
  });
  return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}
