import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  pathsForLoggingIdentity,
  verifyBatchEnvelope,
  verifyCompletedBatchChain,
} from './audit-log.mjs';
import { atomicWriteFile } from './atomic-files.mjs';
import { canonicalTimestamp, exactKeys } from './constants.mjs';

export const UPLOAD_RECEIPT_FORMAT =
  'vhhealth_continuity_edge_log_upload_receipt/v1';

function opaqueDevice(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function remoteFileName(identity, batchId) {
  return [
    identity.tenantId,
    identity.facilityId,
    opaqueDevice(identity.deviceId),
    batchId,
  ].join('__') + '.json';
}

function runRsync(file, remoteName, upload) {
  if (
    !/^[A-Za-z0-9_.@:/-]+$/.test(upload.destination) ||
    upload.destination.includes('..') ||
    !/^[A-Za-z0-9_.-]+\.json$/.test(remoteName)
  ) {
    throw new Error('central drop destination is unsafe');
  }
  const sshCommand = [
    upload.sshBinary,
    '-i',
    upload.identityPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    `UserKnownHostsFile=${upload.knownHostsPath}`,
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ClearAllForwardings=yes',
  ].join(' ');
  const destination = `${upload.destination.replace(/\/+$/, '')}/${remoteName}`;
  const result = spawnSync(
    upload.rsyncBinary,
    [
      '--archive',
      '--ignore-existing',
      '--protect-args',
      '--chmod=F440',
      '-e',
      sshCommand,
      '--',
      file,
      destination,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`log upload failed: ${String(result.stderr || '').trim()}`);
  }
  return destination;
}

export async function uploadCompletedBatches({
  logRoot,
  identities,
  canonical,
  upload,
  now = new Date(),
}) {
  const uploaded = [];
  for (const identity of Object.values(identities)) {
    const paths = pathsForLoggingIdentity(logRoot, identity);
    await mkdir(paths.uploaded, { recursive: true, mode: 0o700 });
    await verifyCompletedBatchChain(logRoot, identity, canonical);
    let files;
    try {
      files = await readdir(paths.completed, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of files.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) {
        throw new Error('completed log spool contains an unexpected entry');
      }
      const batchId = entry.name.slice(0, -5);
      const receiptPath = path.join(paths.uploaded, entry.name);
      try {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
        if (
          !exactKeys(receipt, [
            'batchId',
            'batchSha256',
            'format',
            'remoteName',
            'uploadedAt',
          ]) ||
          receipt.format !== UPLOAD_RECEIPT_FORMAT ||
          receipt.batchId !== batchId
        ) {
          throw new Error('upload receipt is invalid');
        }
        canonicalTimestamp(receipt.uploadedAt, 'uploadedAt');
        continue;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }

      const file = path.join(paths.completed, entry.name);
      const [envelope, certificatePem] = await Promise.all([
        readFile(file, 'utf8').then(JSON.parse),
        readFile(identity.certificatePath, 'utf8'),
      ]);
      const verified = await verifyBatchEnvelope(envelope, {
        identity,
        canonical,
        certificatePem,
      });
      const remoteName = remoteFileName(identity, batchId);
      runRsync(file, remoteName, upload);
      const receipt = {
        format: UPLOAD_RECEIPT_FORMAT,
        batchId,
        batchSha256: verified.contentHash,
        remoteName,
        uploadedAt: now.toISOString(),
      };
      await atomicWriteFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      uploaded.push(receipt);
    }
  }
  return uploaded;
}
