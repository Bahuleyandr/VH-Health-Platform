const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  CopyObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const {
  CF_ACCOUNT_ID,
  CF_R2_BUCKET,
  CF_R2_URL,
  CF_R2_ACCESS_KEY_ID,
  CF_R2_SECRET_ACCESS_KEY
} = process.env;

if (!CF_ACCOUNT_ID || !CF_R2_BUCKET || !CF_R2_URL || !CF_R2_ACCESS_KEY_ID || !CF_R2_SECRET_ACCESS_KEY) {
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
exports.uploadFileToR2 = async (buffer, key, contentType = 'application/octet-stream') => {
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
    console.error(`❌ Failed to upload ${key}:`, err);
    throw err;
  }
};

// ✅ Get File Buffer from R2
exports.getFileFromR2 = async (key) => {
  try {
    const command = new GetObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key
    });
    const response = await s3Client.send(command);
    return response.Body.transformToByteArray();
  } catch (err) {
    console.error(`❌ Failed to get file ${key}:`, err);
    throw err;
  }
};

// ✅ Generate Signed URL (optional)
exports.getSignedUrlFromR2 = async (key, expiresInSeconds = 3600) => {
  try {
    const command = new GetObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key
    });
    return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  } catch (err) {
    console.error(`❌ Failed to generate signed URL for ${key}:`, err);
    throw err;
  }
};

// ✅ Delete File from R2
exports.deleteFileFromR2 = async (key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key
    });
    await s3Client.send(command);
    return true;
  } catch (err) {
    console.error(`❌ Failed to delete ${key}:`, err);
    throw err;
  }
};

// ✅ List All Objects in R2 Bucket (Pagination Support)
exports.listObjectsV2 = async () => {
  try {
    let allObjects = [];
    let continuationToken;

    do {
      const command = new ListObjectsV2Command({
        Bucket: CF_R2_BUCKET,
        ContinuationToken: continuationToken
      });
      const response = await s3Client.send(command);
      allObjects = allObjects.concat(response.Contents || []);
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return allObjects;
  } catch (err) {
    console.error('❌ Failed to list objects:', err);
    throw err;
  }
};

// ✅ Delete Object by Key
exports.deleteObject = async (key) => {
  try {
    const command = new DeleteObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key,
    });
    await s3Client.send(command);
  } catch (err) {
    console.error(`❌ Failed to delete object ${key}:`, err);
    throw err;
  }
};

// ✅ Copy Object by Key
exports.copyObject = async (sourceKey, targetKey) => {
  try {
    const command = new CopyObjectCommand({
      Bucket: CF_R2_BUCKET,
      CopySource: `/${CF_R2_BUCKET}/${sourceKey}`,
      Key: targetKey,
    });
    await s3Client.send(command);
  } catch (err) {
    console.error(`❌ Failed to copy ${sourceKey} to ${targetKey}:`, err);
    throw err;
  }
};
