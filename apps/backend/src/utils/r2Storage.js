// src/utils/r2Storage.js
//
// Storage layer with two backends:
//   - Cloudflare R2 (production) — used when CF_R2_* env vars are set
//   - Local disk (dev/CI fallback) — used when R2 env vars are absent
//
// Public surface is identical for both (uploadFileToR2, getFileFromR2,
// deleteObject, listObjectsV2, copyObject, getSignedFileUrl), so callers
// (bookingController, appointmentDocumentController, recordService, the
// upload route, the cleanup cron, etc.) don't need to know which backend
// is active.
//
// The local backend stores files under `STORAGE_LOCAL_DIR` (default
// `<backend>/storage/local-r2/`) using the same `key` the R2 path would.
// `getSignedFileUrl` returns a backend URL pointing to a token-protected
// streaming route — semantics match R2 signed URLs (short-lived, no JWT
// required, can be downloaded by a plain HTTP client like the patient
// app's `CacheFileUtils.downloadAndCacheFile`).

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../logging/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { CF_ACCOUNT_ID, CF_R2_BUCKET, CF_R2_URL, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY } =
  process.env;

const R2_AVAILABLE = !!(CF_ACCOUNT_ID && CF_R2_BUCKET && CF_R2_URL && CF_R2_ACCESS_KEY_ID && CF_R2_SECRET_ACCESS_KEY);

// ─── Local-disk fallback configuration ─────────────────────────────────────
const LOCAL_DIR = process.env.STORAGE_LOCAL_DIR
  || path.resolve(__dirname, '../../storage/local-r2');

// Fallback base URL when no request context is available (cron jobs,
// background tasks). The preferred path is for callers in HTTP context
// to pass `{ baseUrl }` derived from `req.protocol + req.get('host')` so
// the URL matches whatever host the client used to reach us — works for
// localhost, Android emulator (10.0.2.2:5000), real device on a LAN IP,
// or a tunnel like ngrok without any env-var dance.
const PUBLIC_BASE_URL = process.env.STORAGE_PUBLIC_BASE_URL
  || process.env.PUBLIC_BASE_URL
  || 'http://localhost:5000';

// Token-signing secret (audit finding L3, 2026-06-10): previously this
// REUSED JWT_SECRET verbatim, coupling the auth and storage trust domains —
// a leak of either secret compromised both. Now:
//   * STORAGE_TOKEN_SECRET env wins when set (full domain separation);
//   * otherwise an HKDF-style sub-key is derived from JWT_SECRET with a
//     fixed domain-separation label, so storage tokens can never be replayed
//     as JWTs (and vice versa) even without new env plumbing.
// Validated at first signed-URL request — startup doesn't crash without it.
const TOKEN_SECRET = process.env.STORAGE_TOKEN_SECRET
  || (process.env.JWT_SECRET
    ? crypto.createHmac('sha256', process.env.JWT_SECRET).update('vhhealth-storage-token-v1').digest('hex')
    : undefined);

if (R2_AVAILABLE) {
  logger.info('✅ R2 storage configured');
} else {
  logger.warn(`⚠️ R2 not configured — falling back to local disk at ${LOCAL_DIR}`);
  try {
    fs.mkdirSync(LOCAL_DIR, { recursive: true });
  } catch (e) {
    logger.error(`❌ Failed to create local storage dir: ${e.message}`);
  }
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

// Kept for backward compatibility: callers that imported `ensureR2Available`
// to check storage availability still work, but it now succeeds for either
// backend.
function ensureR2Available() {
  if (!R2_AVAILABLE) {
    // Local backend handles every operation — no-op.
    return;
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

// ─── Path helpers (local backend) ──────────────────────────────────────────

// Map a storage key (e.g. "uploads/<uid>/123_x.pdf") into a safe local path.
// Refuses any key that resolves outside LOCAL_DIR (path traversal guard).
function keyToLocalPath(key) {
  const normalized = path.posix.normalize(key).replace(/^\/+/, '');
  if (normalized.startsWith('..') || normalized.includes('\0')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  const full = path.resolve(LOCAL_DIR, normalized);
  if (!full.startsWith(path.resolve(LOCAL_DIR))) {
    throw new Error(`Storage key escapes local dir: ${key}`);
  }
  return full;
}

// HMAC-signed token for the local stream route. Shape: `<sigBase64Url>.<expiryMs>`.
function signLocalToken(key, expiresInSeconds) {
  if (!TOKEN_SECRET) {
    throw new Error('JWT_SECRET not set — cannot sign local storage URLs');
  }
  const expiryMs = Date.now() + expiresInSeconds * 1000;
  const payload = `${key}|${expiryMs}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${sig}.${expiryMs}`;
}

// Verifies a token returned by `signLocalToken`. Returns true / false.
// Exported for the storage stream route.
export function verifyLocalToken(key, token) {
  if (!TOKEN_SECRET || !token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const sig = token.slice(0, dot);
  const expiryMs = Number(token.slice(dot + 1));
  if (!Number.isFinite(expiryMs) || Date.now() > expiryMs) return false;
  const payload = `${key}|${expiryMs}`;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Exposed so the streaming route can resolve a key to its local file path
// without re-implementing the path-traversal guard.
export function resolveLocalKey(key) {
  return keyToLocalPath(key);
}

// True when this process is operating in local-fallback mode. Routes can
// gate registration on this — there's no point mounting the local stream
// handler when R2 is in front.
export const isLocalStorage = !R2_AVAILABLE;

// ─── Public API (dispatches to R2 or local) ────────────────────────────────

export async function uploadFileToR2(buffer, key, contentType = 'application/octet-stream') {
  if (!R2_AVAILABLE) {
    const full = keyToLocalPath(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    // Mirror R2's "URL string" return contract (callers store this in
    // file_metadata.storage_url). The persistent URL is rebuilt at read
    // time via getSignedFileUrl, so this can be any stable identifier.
    return `local://${key}`;
  }
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

export async function getFileFromR2(key) {
  if (!R2_AVAILABLE) {
    const full = keyToLocalPath(key);
    if (!fs.existsSync(full)) {
      const err = new Error(`File not found: ${key}`);
      err.code = 'NoSuchKey';
      throw err;
    }
    return new Uint8Array(fs.readFileSync(full));
  }
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

export async function deleteObject(key) {
  if (!R2_AVAILABLE) {
    const full = keyToLocalPath(key);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    return;
  }
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

export async function listObjectsV2(continuationToken = undefined) {
  if (!R2_AVAILABLE) {
    // Mimic the S3 ListObjectsV2 response shape just enough for the cleanup
    // cron (`r2CleanupJob.js` only reads `Contents[].Key` and `Contents[].LastModified`).
    const out = { Contents: [], IsTruncated: false };
    if (!fs.existsSync(LOCAL_DIR)) return out;
    const walk = (dir, base) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        const rel = path.posix.join(base, entry.name);
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else {
          const stat = fs.statSync(abs);
          out.Contents.push({ Key: rel, LastModified: stat.mtime, Size: stat.size });
        }
      }
    };
    walk(LOCAL_DIR, '');
    return out;
  }
  ensureR2Available();
  const command = new ListObjectsV2Command({
    Bucket: CF_R2_BUCKET,
    ContinuationToken: continuationToken
  });
  return await s3Client.send(command);
}

export async function copyObject(sourceKey, destinationKey) {
  if (!R2_AVAILABLE) {
    const src = keyToLocalPath(sourceKey);
    const dst = keyToLocalPath(destinationKey);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return;
  }
  ensureR2Available();
  const command = new CopyObjectCommand({
    Bucket: CF_R2_BUCKET,
    CopySource: `${CF_R2_BUCKET}/${sourceKey}`,
    Key: destinationKey
  });
  return await s3Client.send(command);
}

// `options.baseUrl` lets HTTP-context callers (controllers) pass the
// request-derived host so the signed URL points back at whatever the
// client actually used (localhost, 10.0.2.2:5000, a LAN IP, etc.).
// Without it we fall back to PUBLIC_BASE_URL — fine for cron/background
// callers since they don't surface the URL to a user.
export async function getSignedFileUrl(key, expiresInSeconds = 3600, options = {}) {
  if (!R2_AVAILABLE) {
    const token = signLocalToken(key, expiresInSeconds);
    // Path-encode each segment so '/' separators are preserved (the route
    // uses a wildcard splat and rebuilds the key by joining segments).
    const safeKey = key.split('/').map(encodeURIComponent).join('/');
    const baseUrl = options.baseUrl || PUBLIC_BASE_URL;
    return `${baseUrl}/api/v1/storage/file/${safeKey}?token=${token}`;
  }
  return withRetry(async () => {
    const command = new GetObjectCommand({
      Bucket: CF_R2_BUCKET,
      Key: key
    });
    return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
  });
}
