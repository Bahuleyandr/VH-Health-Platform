import {
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  POINTER_FORMAT,
  canonicalTimestamp,
  exactKeys,
  normalizeVersion,
} from './constants.mjs';
import {
  pathsForLoggingIdentity,
  verifyBatchEnvelope,
} from './audit-log.mjs';
import { UPLOAD_RECEIPT_FORMAT } from './upload.mjs';
import {
  facilityDirectory,
  readCurrentSelection,
  sha256Hex,
} from './pointer.mjs';
import { withDirectoryLock } from './lock.mjs';

async function hardLinkTree(source, destination) {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink()) throw new Error('SYMLINK_ESCAPE');
  if (!sourceStat.isDirectory()) throw new Error('candidate set is not a directory');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('SYMLINK_ESCAPE');
    if (entry.isDirectory()) {
      await hardLinkTree(from, to);
    } else if (entry.isFile()) {
      await link(from, to);
    } else {
      throw new Error('ASSET_EXTRA');
    }
  }
}

async function verifyHistoricalSet({
  dataRoot,
  candidate,
  scope,
  trustedKeys,
  runtime,
}) {
  const manifestBytes = await readFile(path.join(candidate, 'manifest.json'));
  const manifestEnvelope = JSON.parse(manifestBytes.toString('utf8'));
  const content = manifestEnvelope?.content;
  const manifestVersion = normalizeVersion(content?.manifestVersion);
  const policyVersion = normalizeVersion(content?.policy?.version);
  const revocationEpoch = normalizeVersion(content?.policy?.revocationEpoch, {
    allowZero: true,
  });
  const accessRevision = normalizeVersion(content?.edgeAccess?.accessRevision, {
    allowZero: true,
  });
  const trustedNow = canonicalTimestamp(manifestEnvelope.issuedAt, 'manifest.issuedAt');
  const verificationRoot = path.join(
    dataRoot,
    '.purge-verify',
    randomUUID(),
    'root',
  );
  const facility = facilityDirectory(
    verificationRoot,
    scope.tenantId,
    scope.facilityId,
  );
  const linkedSet = path.join(facility, 'sets', `v${manifestVersion}`);
  try {
    await hardLinkTree(candidate, linkedSet);
    const pointer = {
      schema: POINTER_FORMAT,
      tenant_id: scope.tenantId,
      facility_id: scope.facilityId,
      manifest_version: manifestVersion,
      set: `sets/v${manifestVersion}`,
      manifest: `sets/v${manifestVersion}/manifest.json`,
      manifest_sha256: sha256Hex(manifestBytes),
    };
    await mkdir(facility, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(facility, 'current.json'),
      `${JSON.stringify(pointer)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const verified = await runtime.verifyContinuityEdgeMirror({
      root: verificationRoot,
      tenantId: scope.tenantId,
      facilityId: scope.facilityId,
      trustedKeys: trustedKeys.packKeys,
      persistedFloors: {
        manifestVersion,
        policyVersion,
        revocationEpoch,
        accessRevision,
        trustedNow,
      },
      trustedNow,
      clockTrusted: true,
    });
    if (!verified.ok) throw new Error(verified.reason);
    return { manifestEnvelope, verified };
  } finally {
    await rm(path.join(dataRoot, '.purge-verify'), {
      recursive: true,
      force: true,
    });
  }
}

async function pointerUnchanged(dataRoot, scope, expectedBytes) {
  const current = await readCurrentSelection(dataRoot, scope);
  return Buffer.compare(current.pointerBytes, expectedBytes) === 0;
}

export async function purgeObsoleteSets({
  dataRoot,
  scope,
  trustedKeys,
  runtime,
  policy,
  now = new Date(),
}) {
  const lockPath = path.join(dataRoot, 'state', 'activation.lock');
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return withDirectoryLock(lockPath, () =>
    purgeObsoleteSetsUnderLock({
      dataRoot,
      scope,
      trustedKeys,
      runtime,
      policy,
      now,
    }),
  );
}

export async function purgeObsoleteSetsUnderLock({
  dataRoot,
  scope,
  trustedKeys,
  runtime,
  policy,
  now = new Date(),
}) {
  const selected = await readCurrentSelection(dataRoot, scope);
  const setsRoot = path.join(selected.directory, 'sets');
  const retentionMs =
    policy.decisions.retention.edgePackRetentionHours * 60 * 60 * 1000;
  const removed = [];
  const entries = await readdir(setsRoot, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !/^v[1-9][0-9]*$/.test(entry.name)) {
      throw new Error('sets directory contains a non-versioned entry');
    }
    if (selected.pointer.set === `sets/${entry.name}`) continue;
    const candidate = path.join(setsRoot, entry.name);
    const historical = await verifyHistoricalSet({
      dataRoot,
      candidate,
      scope,
      trustedKeys,
      runtime,
    });
    const issuedAt = Date.parse(historical.manifestEnvelope.issuedAt);
    if (!Number.isFinite(issuedAt) || now.getTime() - issuedAt < retentionMs) {
      continue;
    }
    if (!(await pointerUnchanged(dataRoot, scope, selected.pointerBytes))) {
      throw new Error('CURRENT_POINTER_CHANGED');
    }
    await rm(candidate, { recursive: true, force: false });
    removed.push(entry.name);
  }
  return removed;
}

export async function purgeUploadedLogs({
  logRoot,
  identities,
  canonical,
  policy,
  now = new Date(),
}) {
  const retentionMs =
    policy.decisions.retention.accessLogRetentionHours * 60 * 60 * 1000;
  const removed = [];
  for (const identity of Object.values(identities)) {
    const paths = pathsForLoggingIdentity(logRoot, identity);
    let entries;
    try {
      entries = await readdir(paths.completed, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) {
        throw new Error('completed log spool contains an unexpected entry');
      }
      const batchPath = path.join(paths.completed, entry.name);
      const receiptPath = path.join(paths.uploaded, entry.name);
      let receipt;
      try {
        receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (
        !exactKeys(receipt, [
          'batchId',
          'batchSha256',
          'format',
          'remoteName',
          'uploadedAt',
        ]) ||
        receipt.format !== UPLOAD_RECEIPT_FORMAT ||
        receipt.batchId !== entry.name.slice(0, -5)
      ) {
        throw new Error('upload receipt is invalid');
      }
      const [envelope, certificatePem] = await Promise.all([
        readFile(batchPath, 'utf8').then(JSON.parse),
        readFile(identity.certificatePath, 'utf8'),
      ]);
      const verified = await verifyBatchEnvelope(envelope, {
        identity,
        canonical,
        certificatePem,
      });
      if (verified.contentHash !== receipt.batchSha256) {
        throw new Error('upload receipt does not match completed batch');
      }
      const lastEventAt = Date.parse(envelope.content.lastEventAt);
      if (!Number.isFinite(lastEventAt) || now.getTime() - lastEventAt < retentionMs) {
        continue;
      }
      await rm(batchPath);
      await rm(receiptPath);
      removed.push(entry.name);
    }
  }
  return removed;
}
