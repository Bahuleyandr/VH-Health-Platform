import {
  X509Certificate,
  createHash,
  createPrivateKey,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {
  AUDIT_EVENT_FORMAT,
  AUDIT_HEAD_FORMAT,
  HASH_PATTERN,
  LOCATION_TYPES,
  LOG_BATCH_FORMAT,
  UUID_PATTERN,
  canonicalTimestamp,
  exactKeys,
  normalizeFacilityId,
  normalizeTenantId,
  normalizeVersion,
} from './constants.mjs';
import { atomicWriteFile, fsyncDirectory } from './atomic-files.mjs';
import { assertProtectedFile, readProtectedJson } from './json-files.mjs';
import { withDirectoryLock } from './lock.mjs';

const IDENTITIES_FORMAT = 'vhhealth_continuity_edge_logging_identities/v1';
const IDENTITIES_KEYS = [
  'accessRevision',
  'certificatePath',
  'deviceId',
  'facilityId',
  'grantId',
  'locationIdentifier',
  'locationType',
  'policyVersion',
  'policyVersionId',
  'privateKeyPath',
  'tenantId',
];
const HEAD_KEYS = [
  'activeBatchId',
  'activeByteLength',
  'activeEventCount',
  'activeStartPreviousEventHash',
  'activeStartSequence',
  'format',
  'identityHash',
  'lastEventHash',
  'lastSequence',
  'previousBatchSha256',
];
const EVENT_KEYS = [
  'accessGrantId',
  'accessRevision',
  'asset',
  'clientCertificateSha256',
  'deviceId',
  'eventHash',
  'facilityId',
  'format',
  'locationIdentifier',
  'locationType',
  'loggingGrantId',
  'method',
  'occurredAt',
  'outcome',
  'policyVersion',
  'previousEventHash',
  'sequence',
  'staffUid',
  'tenantId',
];
const BATCH_CONTENT_KEYS = [
  'accessRevision',
  'batchId',
  'deviceId',
  'events',
  'facilityId',
  'firstEventAt',
  'firstEventSequence',
  'format',
  'grantId',
  'lastEventAt',
  'lastEventSequence',
  'policyVersion',
  'policyVersionId',
  'previousBatchSha256',
  'tenantId',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function certFingerprint(certificate) {
  return certificate.fingerprint256.replaceAll(':', '').toLowerCase();
}

function scopeKey(identity) {
  return sha256(
    [
      identity.tenantId,
      identity.facilityId,
      identity.locationType,
      identity.locationIdentifier,
      identity.deviceId,
      identity.grantId,
    ].join('\0'),
  );
}

function normalizeIdentity(value, scope) {
  if (
    !exactKeys(value, IDENTITIES_KEYS) ||
    !UUID_PATTERN.test(String(value.grantId || '')) ||
    !UUID_PATTERN.test(String(value.policyVersionId || '')) ||
    !LOCATION_TYPES.has(value.locationType) ||
    typeof value.locationIdentifier !== 'string' ||
    value.locationIdentifier.length < 1 ||
    value.locationIdentifier.length > 160 ||
    typeof value.deviceId !== 'string' ||
    value.deviceId.length < 1 ||
    value.deviceId.length > 160 ||
    !path.isAbsolute(value.certificatePath) ||
    !path.isAbsolute(value.privateKeyPath)
  ) {
    throw new Error('logging identity is invalid');
  }
  const normalized = {
    ...value,
    tenantId: normalizeTenantId(value.tenantId),
    facilityId: normalizeFacilityId(value.facilityId),
    grantId: value.grantId.toLowerCase(),
    policyVersionId: value.policyVersionId.toLowerCase(),
    policyVersion: normalizeVersion(value.policyVersion),
    accessRevision: normalizeVersion(value.accessRevision),
    certificatePath: path.resolve(value.certificatePath),
    privateKeyPath: path.resolve(value.privateKeyPath),
  };
  if (
    normalized.tenantId !== normalizeTenantId(scope.tenantId) ||
    normalized.facilityId !== normalizeFacilityId(scope.facilityId)
  ) {
    throw new Error('logging identity audience mismatch');
  }
  return normalized;
}

export async function loadLoggingIdentities(file, scope) {
  const value = await readProtectedJson(file, {
    label: 'logging identities file',
  });
  if (
    !exactKeys(value, ['format', 'locations']) ||
    value.format !== IDENTITIES_FORMAT ||
    !value.locations ||
    typeof value.locations !== 'object' ||
    Array.isArray(value.locations)
  ) {
    throw new Error('logging identities file is invalid');
  }
  const result = {};
  for (const [location, identity] of Object.entries(value.locations)) {
    const normalized = normalizeIdentity(identity, scope);
    const expected = `${normalized.locationType}/${normalized.locationIdentifier}`;
    if (location !== expected || Object.hasOwn(result, location)) {
      throw new Error('logging identity location key is invalid');
    }
    result[location] = normalized;
  }
  if (Object.keys(result).length === 0) {
    throw new Error('logging identities file has no location-scoped identity');
  }
  return result;
}

function headFor(identity) {
  return {
    format: AUDIT_HEAD_FORMAT,
    identityHash: scopeKey(identity),
    activeBatchId: randomUUID(),
    activeByteLength: 0,
    activeEventCount: 0,
    activeStartSequence: 1,
    activeStartPreviousEventHash: null,
    lastSequence: 0,
    lastEventHash: null,
    previousBatchSha256: null,
  };
}

function auditPaths(logRoot, identity) {
  const key = scopeKey(identity);
  return {
    key,
    active: path.join(logRoot, 'active', `${key}.jsonl`),
    head: path.join(logRoot, 'heads', `${key}.json`),
    completed: path.join(logRoot, 'completed', key),
    uploaded: path.join(logRoot, 'uploaded', key),
    lock: path.join(logRoot, 'locks', `${key}.lock`),
  };
}

async function readOrInitializeHead(paths, identity) {
  await Promise.all([
    mkdir(path.dirname(paths.active), { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(paths.head), { recursive: true, mode: 0o700 }),
    mkdir(paths.completed, { recursive: true, mode: 0o700 }),
    mkdir(paths.uploaded, { recursive: true, mode: 0o700 }),
    mkdir(path.dirname(paths.lock), { recursive: true, mode: 0o700 }),
  ]);
  try {
    await access(paths.head);
    const head = await readProtectedJson(paths.head, { label: 'audit head receipt' });
    if (
      !exactKeys(head, HEAD_KEYS) ||
      head.format !== AUDIT_HEAD_FORMAT ||
      head.identityHash !== scopeKey(identity) ||
      !UUID_PATTERN.test(String(head.activeBatchId || '')) ||
      !Number.isSafeInteger(head.lastSequence) ||
      head.lastSequence < 0 ||
      !Number.isSafeInteger(head.activeEventCount) ||
      head.activeEventCount < 0 ||
      !Number.isSafeInteger(head.activeByteLength) ||
      head.activeByteLength < 0 ||
      !Number.isSafeInteger(head.activeStartSequence) ||
      head.activeStartSequence < 1 ||
      ![head.lastEventHash, head.previousBatchSha256, head.activeStartPreviousEventHash]
        .every((hash) => hash === null || HASH_PATTERN.test(hash))
    ) {
      throw new Error('AUDIT_HEAD_INVALID');
    }
    return head;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const head = headFor(identity);
  await atomicWriteFile(paths.active, '', { mode: 0o600 });
  await atomicWriteFile(paths.head, `${JSON.stringify(head, null, 2)}\n`);
  return head;
}

function eventHash(event, canonical) {
  const unsigned = { ...event };
  delete unsigned.eventHash;
  return canonical.hashCanonicalValue(unsigned);
}

export async function verifyActiveJournal(logRoot, identity, canonical) {
  const paths = auditPaths(path.resolve(logRoot), identity);
  const head = await readOrInitializeHead(paths, identity);
  const bytes = await readFile(paths.active);
  if (bytes.length !== head.activeByteLength) {
    throw new Error('AUDIT_LOG_TRUNCATED_OR_REWRITTEN');
  }
  const text = bytes.toString('utf8');
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new Error('AUDIT_LOG_TRUNCATED_OR_REWRITTEN');
  }
  const lines = text.length === 0 ? [] : text.slice(0, -1).split('\n');
  if (lines.length !== head.activeEventCount) {
    throw new Error('AUDIT_LOG_TRUNCATED_OR_REWRITTEN');
  }
  let previousHash = head.activeStartPreviousEventHash;
  let expectedSequence = head.activeStartSequence;
  const events = [];
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error('AUDIT_LOG_TRUNCATED_OR_REWRITTEN');
    }
    if (
      !exactKeys(event, EVENT_KEYS) ||
      event.format !== AUDIT_EVENT_FORMAT ||
      event.sequence !== expectedSequence ||
      event.previousEventHash !== previousHash ||
      !HASH_PATTERN.test(String(event.eventHash || '')) ||
      eventHash(event, canonical) !== event.eventHash
    ) {
      throw new Error('AUDIT_LOG_HASH_CHAIN_GAP');
    }
    canonicalTimestamp(event.occurredAt, 'audit event occurredAt');
    previousHash = event.eventHash;
    expectedSequence += 1;
    events.push(event);
  }
  if (
    head.lastSequence !== expectedSequence - 1 ||
    head.lastEventHash !== previousHash
  ) {
    throw new Error('AUDIT_LOG_HASH_CHAIN_GAP');
  }
  return { head, events, paths };
}

function normalizeEvent(value, identity, head, canonical) {
  const occurredAt = canonicalTimestamp(
    value.occurredAt || new Date().toISOString(),
    'occurredAt',
  );
  const event = {
    format: AUDIT_EVENT_FORMAT,
    sequence: head.lastSequence + 1,
    occurredAt,
    tenantId: identity.tenantId,
    facilityId: identity.facilityId,
    locationType: identity.locationType,
    locationIdentifier: identity.locationIdentifier,
    staffUid: String(value.staffUid || '').toLowerCase(),
    deviceId: String(value.deviceId || ''),
    clientCertificateSha256: String(value.clientCertificateSha256 || ''),
    accessGrantId:
      value.accessGrantId == null
        ? null
        : String(value.accessGrantId).toLowerCase(),
    loggingGrantId: identity.grantId,
    policyVersion: identity.policyVersion,
    accessRevision: identity.accessRevision,
    method: String(value.method || ''),
    asset: String(value.asset || ''),
    outcome: String(value.outcome || ''),
    previousEventHash: head.lastEventHash,
  };
  if (
    !UUID_PATTERN.test(event.staffUid) ||
    !(
      (event.outcome === 'authorized' && UUID_PATTERN.test(event.accessGrantId)) ||
      (event.outcome === 'denied' && event.accessGrantId === null)
    ) ||
    !HASH_PATTERN.test(event.clientCertificateSha256) ||
    !['GET', 'HEAD'].includes(event.method) ||
    !['pack.html', 'pack.json'].includes(event.asset) ||
    !['authorized', 'denied'].includes(event.outcome) ||
    event.deviceId.length < 1 ||
    event.deviceId.length > 160
  ) {
    throw new Error('audit event is invalid');
  }
  event.eventHash = eventHash(event, canonical);
  return event;
}

export async function appendAuditEvent({
  logRoot,
  identity,
  event,
  canonical,
}) {
  const paths = auditPaths(path.resolve(logRoot), identity);
  await mkdir(path.dirname(paths.lock), { recursive: true, mode: 0o700 });
  return withDirectoryLock(paths.lock, async () => {
    const verified = await verifyActiveJournal(logRoot, identity, canonical);
    const nextEvent = normalizeEvent(event, identity, verified.head, canonical);
    const line = `${canonical.canonicalizeJson(nextEvent)}\n`;
    const handle = await open(paths.active, 'a', 0o600);
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const nextHead = {
      ...verified.head,
      activeByteLength: verified.head.activeByteLength + Buffer.byteLength(line),
      activeEventCount: verified.head.activeEventCount + 1,
      lastSequence: nextEvent.sequence,
      lastEventHash: nextEvent.eventHash,
    };
    await atomicWriteFile(paths.head, `${JSON.stringify(nextHead, null, 2)}\n`);
    return { event: nextEvent, head: nextHead };
  });
}

async function signingMaterial(identity) {
  await Promise.all([
    assertProtectedFile(identity.certificatePath, {
      label: 'logging certificate',
    }),
    assertProtectedFile(identity.privateKeyPath, {
      label: 'logging private key',
    }),
  ]);
  const [certificatePem, privateKeyPem] = await Promise.all([
    readFile(identity.certificatePath, 'utf8'),
    readFile(identity.privateKeyPath, 'utf8'),
  ]);
  const certificate = new X509Certificate(certificatePem);
  const privateKey = createPrivateKey(privateKeyPem);
  return { certificate, privateKey };
}

export async function verifyLoggingIdentityMaterial(identity) {
  const { certificate, privateKey } = await signingMaterial(identity);
  const now = Date.now();
  if (
    certificate.publicKey.asymmetricKeyType !== 'ed25519' ||
    privateKey.asymmetricKeyType !== 'ed25519' ||
    now < Date.parse(certificate.validFrom) ||
    now >= Date.parse(certificate.validTo)
  ) {
    throw new Error('logging identity must use a currently valid Ed25519 certificate');
  }
  const challenge = Buffer.from('vhhealth-continuity-edge-logging-preflight');
  const signature = cryptoSign(null, challenge, privateKey);
  if (!cryptoVerify(null, challenge, certificate.publicKey, signature)) {
    throw new Error('logging certificate does not match its private key');
  }
  return {
    certificateSha256: certFingerprint(certificate),
  };
}

export async function sealAuditBatch({
  logRoot,
  identity,
  canonical,
}) {
  const paths = auditPaths(path.resolve(logRoot), identity);
  await mkdir(path.dirname(paths.lock), { recursive: true, mode: 0o700 });
  return withDirectoryLock(paths.lock, async () => {
    const verified = await verifyActiveJournal(logRoot, identity, canonical);
    if (verified.events.length === 0) return null;
    const first = verified.events[0];
    const last = verified.events.at(-1);
    const content = {
      accessRevision: identity.accessRevision,
      batchId: verified.head.activeBatchId,
      deviceId: identity.deviceId,
      events: verified.events,
      facilityId: identity.facilityId,
      firstEventAt: first.occurredAt,
      firstEventSequence: first.sequence,
      format: LOG_BATCH_FORMAT,
      grantId: identity.grantId,
      lastEventAt: last.occurredAt,
      lastEventSequence: last.sequence,
      policyVersion: identity.policyVersion,
      policyVersionId: identity.policyVersionId,
      previousBatchSha256: verified.head.previousBatchSha256,
      tenantId: identity.tenantId,
    };
    const { certificate, privateKey } = await signingMaterial(identity);
    const canonicalContent = canonical.canonicalizeJson(content);
    const signatureBytes = cryptoSign(null, Buffer.from(canonicalContent), privateKey);
    if (
      !cryptoVerify(
        null,
        Buffer.from(canonicalContent),
        certificate.publicKey,
        signatureBytes,
      )
    ) {
      throw new Error('logging certificate does not match its private key');
    }
    const envelope = {
      algorithm: 'Ed25519',
      content,
      contentHash: sha256(canonicalContent),
      keyFingerprint: certFingerprint(certificate),
      signature: signatureBytes.toString('base64'),
    };
    const completed = path.join(paths.completed, `${content.batchId}.json`);
    await atomicWriteFile(
      completed,
      `${canonical.canonicalizeJson(envelope)}\n`,
      { mode: 0o600 },
    );
    await fsyncDirectory(paths.completed);

    const nextHead = {
      ...verified.head,
      activeBatchId: randomUUID(),
      activeByteLength: 0,
      activeEventCount: 0,
      activeStartSequence: verified.head.lastSequence + 1,
      activeStartPreviousEventHash: verified.head.lastEventHash,
      previousBatchSha256: envelope.contentHash,
    };
    await atomicWriteFile(paths.active, '', { mode: 0o600 });
    await atomicWriteFile(paths.head, `${JSON.stringify(nextHead, null, 2)}\n`);
    return { envelope, completed, head: nextHead };
  });
}

export async function verifyBatchEnvelope(
  envelope,
  { identity, canonical, certificatePem },
) {
  if (
    !exactKeys(envelope, [
      'algorithm',
      'content',
      'contentHash',
      'keyFingerprint',
      'signature',
    ]) ||
    envelope.algorithm !== 'Ed25519' ||
    !HASH_PATTERN.test(String(envelope.contentHash || '')) ||
    !HASH_PATTERN.test(String(envelope.keyFingerprint || '')) ||
    !/^[A-Za-z0-9+/]{86}==$/.test(String(envelope.signature || '')) ||
    !exactKeys(envelope.content, BATCH_CONTENT_KEYS) ||
    envelope.content.format !== LOG_BATCH_FORMAT
  ) {
    throw new Error('AUDIT_BATCH_INVALID');
  }
  const certificate = new X509Certificate(certificatePem);
  const canonicalContent = canonical.canonicalizeJson(envelope.content);
  if (
    sha256(canonicalContent) !== envelope.contentHash ||
    certFingerprint(certificate) !== envelope.keyFingerprint ||
    !cryptoVerify(
      null,
      Buffer.from(canonicalContent),
      certificate.publicKey,
      Buffer.from(envelope.signature, 'base64'),
    )
  ) {
    throw new Error('AUDIT_BATCH_SIGNATURE_INVALID');
  }
  const content = envelope.content;
  if (
    content.tenantId !== identity.tenantId ||
    content.facilityId !== identity.facilityId ||
    content.deviceId !== identity.deviceId ||
    content.grantId !== identity.grantId ||
    content.policyVersionId !== identity.policyVersionId ||
    String(content.policyVersion) !== identity.policyVersion ||
    String(content.accessRevision) !== identity.accessRevision ||
    !Array.isArray(content.events) ||
    content.events.length === 0 ||
    content.events[0].sequence !== content.firstEventSequence ||
    content.events.at(-1).sequence !== content.lastEventSequence ||
    content.events[0].occurredAt !== content.firstEventAt ||
    content.events.at(-1).occurredAt !== content.lastEventAt
  ) {
    throw new Error('AUDIT_BATCH_SCOPE_INVALID');
  }
  let previousHash = content.events[0].previousEventHash;
  let sequence = content.firstEventSequence;
  for (const event of content.events) {
    if (
      !exactKeys(event, EVENT_KEYS) ||
      event.sequence !== sequence ||
      event.previousEventHash !== previousHash ||
      eventHash(event, canonical) !== event.eventHash
    ) {
      throw new Error('AUDIT_BATCH_HASH_CHAIN_GAP');
    }
    previousHash = event.eventHash;
    sequence += 1;
  }
  return { ok: true, contentHash: envelope.contentHash };
}

export async function verifyCompletedBatchChain(
  logRoot,
  identity,
  canonical,
) {
  const paths = auditPaths(path.resolve(logRoot), identity);
  let entries;
  try {
    entries = await readdir(paths.completed, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const certificatePem = await readFile(identity.certificatePath, 'utf8');
  const batches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) {
      throw new Error('completed log spool contains an unexpected entry');
    }
    const file = path.join(paths.completed, entry.name);
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    await verifyBatchEnvelope(envelope, {
      identity,
      canonical,
      certificatePem,
    });
    if (envelope.content.batchId !== entry.name.slice(0, -5)) {
      throw new Error('AUDIT_BATCH_SCOPE_INVALID');
    }
    batches.push({ file, envelope });
  }
  batches.sort(
    (left, right) =>
      left.envelope.content.firstEventSequence -
      right.envelope.content.firstEventSequence,
  );
  for (let index = 1; index < batches.length; index += 1) {
    const previous = batches[index - 1].envelope;
    const current = batches[index].envelope;
    if (
      current.content.previousBatchSha256 !== previous.contentHash ||
      current.content.firstEventSequence !==
        previous.content.lastEventSequence + 1 ||
      current.content.events[0].previousEventHash !==
        previous.content.events.at(-1).eventHash
    ) {
      throw new Error('AUDIT_BATCH_CHAIN_GAP');
    }
  }
  return batches;
}

export function pathsForLoggingIdentity(logRoot, identity) {
  return auditPaths(path.resolve(logRoot), identity);
}
