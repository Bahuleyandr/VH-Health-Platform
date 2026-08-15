import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir, open, readFile, readdir, rename, stat, unlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const I09_GATEWAY_SEQUENCE_CONTRACT = 'vhhealth.i09.gateway-sequence/v1';
export const POSTGRES_BIGINT_MAX = 9223372036854775807n;

const RESUME_KEYS = Object.freeze([
  'contract', 'interface_family', 'tenant_id', 'offset_id', 'source_partition',
  'generation', 'recovery_state', 'high_water_position', 'high_water_token',
  'retained_from_position', 'retained_from_token', 'resume_cutoff_position',
  'resume_cutoff_token', 'policy_version', 'policy_signature',
  'retention_policy', 'retention_until',
]);
const ZERO_HASH = '0'.repeat(64);
const POSITION_RE = /^(0|[1-9][0-9]*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class SpoolFullError extends Error {
  constructor(message = 'spool full', { gapRecorded = false, scope = 'partition' } = {}) {
    super(message);
    this.code = 'SPOOL_FULL';
    this.gapRecorded = gapRecorded;
    this.scope = scope;
  }
}

export class SpoolIntegrityError extends Error {
  constructor(message, code = 'SPOOL_INTEGRITY_ERROR') {
    super(message);
    this.code = code;
  }
}

export class DuplicateConflictError extends SpoolIntegrityError {
  constructor() {
    super('MSH-10 duplicate identity was reused with different bytes', 'DUPLICATE_FINGERPRINT_CONFLICT');
  }
}

export class MissingMarkerError extends SpoolIntegrityError {
  constructor(message = 'authenticated genesis marker is missing') {
    super(message, 'RECOVERY_MARKER_MISSING');
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function lengthPrefixedSha256(components) {
  const hash = createHash('sha256');
  for (const component of components) {
    const bytes = Buffer.from(String(component), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function i09DuplicateKey({ tenantId, deviceRegistryId, msh10 }) {
  return lengthPrefixedSha256([
    'vh-i09-duplicate-v1',
    String(tenantId).toLowerCase(),
    String(Number(deviceRegistryId)),
    String(msh10),
  ]);
}

export function i09SourceToken({
  tenantId, sourcePartition, generation, sourcePosition, predecessorToken,
  duplicateKey, messageSha256,
}) {
  return lengthPrefixedSha256([
    'vh-i09-source-token-v1',
    String(tenantId).toLowerCase(),
    sourcePartition,
    String(Number(generation)),
    sourcePosition,
    predecessorToken,
    duplicateKey,
    messageSha256,
  ]);
}

export function opaquePartitionRef(sourcePartition) {
  return sha256(Buffer.from(String(sourcePartition), 'utf8')).slice(0, 16);
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new MissingMarkerError(`${label} must be a positive integer`);
  }
  return parsed;
}

function requirePosition(value, label) {
  const text = String(value ?? '');
  if (!POSITION_RE.test(text) || BigInt(text) > POSTGRES_BIGINT_MAX) {
    throw new MissingMarkerError(`${label} must be a PostgreSQL BIGINT position`);
  }
  return text;
}

function requireToken(value, label) {
  const text = String(value ?? '');
  if (!text) throw new MissingMarkerError(`${label} is missing`);
  return text;
}

export function assertResumeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MissingMarkerError('resume state must be an object');
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !RESUME_KEYS.includes(key));
  const missing = RESUME_KEYS.filter((key) => !keys.includes(key));
  if (unknown.length || missing.length) {
    throw new SpoolIntegrityError(
      `resume-state contract fields differ (missing=${missing.join(',')}; unknown=${unknown.join(',')})`,
      'RECOVERY_RESUME_CONTRACT_MISMATCH',
    );
  }
  if (value.contract !== I09_GATEWAY_SEQUENCE_CONTRACT || value.interface_family !== 'I09') {
    throw new SpoolIntegrityError('resume-state contract or interface family differs', 'RECOVERY_RESUME_CONTRACT_MISMATCH');
  }
  requirePositiveInteger(value.generation, 'generation');
  requirePosition(value.high_water_position, 'high_water_position');
  requireToken(value.high_water_token, 'high_water_token');
  if (!value.tenant_id || !value.offset_id || !value.source_partition) {
    throw new MissingMarkerError('resume-state identity is incomplete');
  }
  return value;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (err) {
    if (!['EPERM', 'EISDIR', 'EINVAL', 'EBADF'].includes(err.code)) throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await syncDirectory(dirname(path));
}

async function appendDurable(path, line) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyDurableTail(path, expectedLine, expectedHash) {
  const expected = Buffer.from(expectedLine, 'utf8');
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (info.size < expected.length) return false;
    const actual = Buffer.alloc(expected.length);
    const { bytesRead } = await handle.read(actual, 0, actual.length, info.size - actual.length);
    if (bytesRead !== expected.length || !actual.equals(expected)) return false;
    const parsed = JSON.parse(actual.toString('utf8'));
    return parsed.event_hash === expectedHash
      && parsed.event_hash === sha256(Buffer.from(canonicalJson(withoutHash(parsed)), 'utf8'));
  } finally {
    await handle.close();
  }
}

function withoutHash(event) {
  const { event_hash: _eventHash, ...body } = event;
  return body;
}

function sealEvent(body, priorHash, index) {
  const event = {
    event_index: index,
    previous_event_hash: priorHash,
    ...body,
  };
  return Object.freeze({ ...event, event_hash: sha256(Buffer.from(canonicalJson(event), 'utf8')) });
}

function verifyRecord(record) {
  const { record_checksum: checksum, ...body } = record || {};
  if (!SHA256_RE.test(String(checksum || ''))
    || checksum !== sha256(Buffer.from(canonicalJson(body), 'utf8'))) {
    throw new SpoolIntegrityError('spool record checksum differs', 'SPOOL_RECORD_CORRUPT');
  }
  if ((record.payload_state === 'present') !== (typeof record.message_b64 === 'string')) {
    throw new SpoolIntegrityError('receipt and payload state disagree', 'SPOOL_RECEIPT_PAYLOAD_MISMATCH');
  }
  if (record.payload_state === 'present') {
    const bytes = Buffer.from(record.message_b64, 'base64');
    if (sha256(bytes) !== record.message_sha256) {
      throw new SpoolIntegrityError('payload fingerprint differs from its receipt', 'SPOOL_RECEIPT_PAYLOAD_MISMATCH');
    }
  }
}

function stateFromEvents(events) {
  const accepted = new Map();
  const duplicates = new Map();
  const outcomes = new Map();
  const gaps = [];
  let reconciliation = null;
  for (const event of events) {
    if (event.type === 'accepted') {
      verifyRecord(event.record);
      const position = event.record.source_position;
      if (accepted.has(position) || duplicates.has(event.record.duplicate_key)) {
        throw new SpoolIntegrityError('journal reuses a position or duplicate key', 'SPOOL_CHAIN_CORRUPT');
      }
      accepted.set(position, event.record);
      duplicates.set(event.record.duplicate_key, event.record);
    } else if (event.type === 'outcome') {
      outcomes.set(event.source_position, event);
    } else if (event.type === 'gap') {
      gaps.push(event);
    } else if (event.type === 'reconciliation') {
      reconciliation = { state: event.state, reason: event.reason };
    } else {
      throw new SpoolIntegrityError('journal contains an unknown event type', 'SPOOL_JOURNAL_SCHEMA_MISMATCH');
    }
  }
  return { accepted, duplicates, outcomes, gaps, reconciliation };
}

export class SequencedSpoolStore {
  constructor({ rootDir, globalMaxBytes, gapReserveBytes = 1024 * 1024 }) {
    this.rootDir = rootDir;
    this.globalMaxBytes = requirePositiveInteger(globalMaxBytes, 'globalMaxBytes');
    this.gapReserveBytes = requirePositiveInteger(gapReserveBytes, 'gapReserveBytes');
    this.partitions = new Map();
    this.capacityQueue = Promise.resolve();
  }

  capacityExclusive(operation) {
    const next = this.capacityQueue.then(operation, operation);
    this.capacityQueue = next.catch(() => {});
    return next;
  }

  async totalBytes() {
    let total = 0;
    const root = join(this.rootDir, 'i09');
    let names = [];
    try {
      names = await readdir(root);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const name of names) {
      const journal = join(root, name, 'journal.ndjson');
      try {
        total += (await stat(journal)).size;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return total;
  }

  async openPartition({ resumeState, gatewayRegistryId, deviceRegistryId, partitionMaxBytes }) {
    const resume = assertResumeState(resumeState);
    const gatewayId = requirePositiveInteger(gatewayRegistryId, 'gatewayRegistryId');
    const deviceId = requirePositiveInteger(deviceRegistryId, 'deviceRegistryId');
    const expected = `i09/gateway/${gatewayId}/device/${deviceId}`;
    if (resume.source_partition !== expected) {
      throw new SpoolIntegrityError('resume-state partition differs from provisioned identities', 'RECOVERY_PARTITION_MISMATCH');
    }
    const key = `${resume.tenant_id}:${expected}`;
    let partition = this.partitions.get(key);
    if (!partition) {
      partition = new SequencedPartition({
        store: this,
        resumeState: resume,
        gatewayRegistryId: gatewayId,
        deviceRegistryId: deviceId,
        partitionMaxBytes: requirePositiveInteger(partitionMaxBytes, 'partitionMaxBytes'),
      });
      await partition.initialize();
      this.partitions.set(key, partition);
    } else {
      await partition.observeResumeState(resume);
    }
    return partition;
  }

  async discover() {
    const root = join(this.rootDir, 'i09');
    let names = [];
    try {
      names = await readdir(root);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const manifests = [];
    for (const name of names) {
      try {
        manifests.push(JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8')));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    return manifests;
  }
}

export class SequencedPartition {
  constructor({ store, resumeState, gatewayRegistryId, deviceRegistryId, partitionMaxBytes }) {
    this.store = store;
    this.resume = resumeState;
    this.gatewayRegistryId = gatewayRegistryId;
    this.deviceRegistryId = deviceRegistryId;
    this.partitionMaxBytes = partitionMaxBytes;
    this.ref = opaquePartitionRef(`${resumeState.tenant_id}:${resumeState.source_partition}`);
    this.dir = join(store.rootDir, 'i09', this.ref);
    this.journalFile = join(this.dir, 'journal.ndjson');
    this.manifestFile = join(this.dir, 'manifest.json');
    this.queue = Promise.resolve();
    this.events = [];
    this.state = stateFromEvents([]);
    this.manifest = null;
    this.tornTail = false;
  }

  exclusive(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async initialize() {
    return this.exclusive(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const hasManifest = await exists(this.manifestFile);
      const hasJournal = await exists(this.journalFile);
      if (!hasManifest && hasJournal) {
        throw new MissingMarkerError('local manifest is missing beside existing journal evidence');
      }
      if (hasManifest) {
        this.manifest = JSON.parse(await readFile(this.manifestFile, 'utf8'));
        this.assertManifestIdentity();
        await this.loadJournal();
        await this.repairCheckpointIfNeeded();
      } else {
        this.manifest = this.newManifest(this.resume);
        await atomicWrite(this.manifestFile, `${canonicalJson(this.manifest)}\n`);
      }
      await this.compareResumeState(this.resume);
    });
  }

  newManifest(resume) {
    return {
      schema: I09_GATEWAY_SEQUENCE_CONTRACT,
      tenant_id: resume.tenant_id,
      gateway_registry_id: this.gatewayRegistryId,
      device_registry_id: this.deviceRegistryId,
      offset_id: resume.offset_id,
      source_partition: resume.source_partition,
      generation: Number(resume.generation),
      base_position: resume.high_water_position,
      base_token: resume.high_water_token,
      head_position: resume.high_water_position,
      head_token: resume.high_water_token,
      backend_high_water_position: resume.high_water_position,
      backend_high_water_token: resume.high_water_token,
      backend_recovery_state: resume.recovery_state,
      resume_cutoff_position: resume.resume_cutoff_position,
      resume_cutoff_token: resume.resume_cutoff_token,
      journal_event_count: 0,
      journal_tail_hash: ZERO_HASH,
      local_reconciliation_state: null,
      local_reconciliation_reason: null,
    };
  }

  assertManifestIdentity() {
    const expected = {
      schema: I09_GATEWAY_SEQUENCE_CONTRACT,
      tenant_id: this.resume.tenant_id,
      gateway_registry_id: this.gatewayRegistryId,
      device_registry_id: this.deviceRegistryId,
      offset_id: this.resume.offset_id,
      source_partition: this.resume.source_partition,
      generation: Number(this.resume.generation),
    };
    for (const [key, value] of Object.entries(expected)) {
      if (this.manifest?.[key] !== value) {
        throw new SpoolIntegrityError(`local manifest ${key} belongs to different evidence`, 'FOREIGN_PVC_REFUSED');
      }
    }
    requirePosition(this.manifest.base_position, 'manifest.base_position');
    requireToken(this.manifest.base_token, 'manifest.base_token');
  }

  async loadJournal() {
    this.events = [];
    let raw;
    try {
      raw = await readFile(this.journalFile);
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.state = stateFromEvents([]);
        return;
      }
      throw err;
    }
    if (raw.length > 0 && raw[raw.length - 1] !== 0x0a) {
      const boundary = raw.lastIndexOf(0x0a);
      const valid = boundary >= 0 ? raw.subarray(0, boundary + 1) : Buffer.alloc(0);
      const torn = boundary >= 0 ? raw.subarray(boundary + 1) : raw;
      await atomicWrite(join(this.dir, `torn-tail.${randomUUID()}.evidence`), torn);
      await atomicWrite(this.journalFile, valid);
      raw = valid;
      this.tornTail = true;
    }
    const lines = raw.toString('utf8').split('\n').filter(Boolean);
    let prior = ZERO_HASH;
    for (let index = 0; index < lines.length; index += 1) {
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch {
        throw new SpoolIntegrityError('journal contains malformed JSON', 'SPOOL_JOURNAL_CORRUPT');
      }
      if (event.event_index !== index + 1 || event.previous_event_hash !== prior
        || event.event_hash !== sha256(Buffer.from(canonicalJson(withoutHash(event)), 'utf8'))) {
        throw new SpoolIntegrityError('journal hash chain differs', 'SPOOL_JOURNAL_CORRUPT');
      }
      prior = event.event_hash;
      this.events.push(event);
    }
    this.state = stateFromEvents(this.events);
  }

  derivedHead() {
    if (this.state.accepted.size === 0) {
      return { position: this.manifest.base_position, token: this.manifest.base_token };
    }
    const records = [...this.state.accepted.values()].sort((a, b) => (BigInt(a.source_position) < BigInt(b.source_position) ? -1 : 1));
    let expected = BigInt(this.manifest.base_position) + 1n;
    let predecessor = this.manifest.base_token;
    for (const record of records) {
      if (BigInt(record.source_position) !== expected || record.predecessor_token !== predecessor) {
        throw new SpoolIntegrityError('accepted record sequence or predecessor differs', 'SPOOL_CHAIN_CORRUPT');
      }
      if (i09SourceToken({
        tenantId: record.tenant_id,
        sourcePartition: record.source_partition,
        generation: record.generation,
        sourcePosition: record.source_position,
        predecessorToken: record.predecessor_token,
        duplicateKey: record.duplicate_key,
        messageSha256: record.message_sha256,
      }) !== record.source_token) {
        throw new SpoolIntegrityError('accepted record source token differs', 'SPOOL_CHAIN_CORRUPT');
      }
      predecessor = record.source_token;
      expected += 1n;
    }
    const tail = records.at(-1);
    return { position: tail.source_position, token: tail.source_token };
  }

  async repairCheckpointIfNeeded() {
    const head = this.derivedHead();
    const tailHash = this.events.at(-1)?.event_hash || ZERO_HASH;
    if (this.manifest.head_position !== head.position || this.manifest.head_token !== head.token
      || this.manifest.journal_event_count !== this.events.length
      || this.manifest.journal_tail_hash !== tailHash) {
      this.manifest = {
        ...this.manifest,
        head_position: head.position,
        head_token: head.token,
        journal_event_count: this.events.length,
        journal_tail_hash: tailHash,
      };
      await this.writeManifest();
    }
    if (this.tornTail) {
      await this.appendEvent({
        type: 'reconciliation',
        state: 'reconciliation_required_retention_gap',
        reason: 'torn_tail',
        recorded_at: new Date().toISOString(),
      });
    }
  }

  async writeManifest() {
    await atomicWrite(this.manifestFile, `${canonicalJson(this.manifest)}\n`);
  }

  async appendEvent(body) {
    const prior = this.events.at(-1)?.event_hash || ZERO_HASH;
    const event = sealEvent(body, prior, this.events.length + 1);
    const line = `${canonicalJson(event)}\n`;
    await appendDurable(this.journalFile, line);
    this.events.push(event);
    this.state = stateFromEvents(this.events);
    this.manifest = {
      ...this.manifest,
      journal_event_count: this.events.length,
      journal_tail_hash: event.event_hash,
      ...(body.type === 'reconciliation' ? {
        local_reconciliation_state: body.state,
        local_reconciliation_reason: body.reason,
      } : {}),
    };
    return event;
  }

  async observeResumeState(resumeState) {
    const resume = assertResumeState(resumeState);
    return this.exclusive(async () => {
      this.resume = resume;
      this.assertManifestIdentity();
      await this.loadJournal();
      await this.repairCheckpointIfNeeded();
      await this.compareResumeState(resume);
    });
  }

  localTokenAt(position) {
    if (position === this.manifest.base_position) return this.manifest.base_token;
    return this.state.accepted.get(position)?.source_token || null;
  }

  async compareResumeState(resume) {
    this.assertManifestIdentity();
    const backendPosition = BigInt(resume.high_water_position);
    const localPosition = BigInt(this.manifest.head_position);
    const localAtBackend = this.localTokenAt(resume.high_water_position);
    if (backendPosition > localPosition || !localAtBackend || localAtBackend !== resume.high_water_token) {
      const reason = backendPosition > localPosition ? 'backend_ahead' : 'backend_token_mismatch';
      if (this.manifest.local_reconciliation_reason !== reason) {
        await this.appendEvent({
          type: 'reconciliation',
          state: 'reconciliation_required_source_gap',
          reason,
          recorded_at: new Date().toISOString(),
        });
      }
    }
    this.manifest = {
      ...this.manifest,
      backend_high_water_position: resume.high_water_position,
      backend_high_water_token: resume.high_water_token,
      backend_recovery_state: resume.recovery_state,
      resume_cutoff_position: resume.resume_cutoff_position,
      resume_cutoff_token: resume.resume_cutoff_token,
    };
    await this.writeManifest();
  }

  async block(state, reason) {
    return this.exclusive(async () => {
      if (this.manifest.local_reconciliation_state === state
        && this.manifest.local_reconciliation_reason === reason) return;
      await this.appendEvent({ type: 'reconciliation', state, reason, recorded_at: new Date().toISOString() });
      await this.writeManifest();
    });
  }

  async journalBytes() {
    try {
      return (await stat(this.journalFile)).size;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async recordGap({ msh10, messageSha256, scope, capacityBytes }) {
    const partitionBytes = await this.journalBytes();
    const globalBytes = await this.store.totalBytes();
    const event = sealEvent({
      type: 'gap',
      reason: 'capacity_refusal',
      scope,
      source_partition_ref: this.ref,
      last_committed_position: this.manifest.head_position,
      last_committed_token: this.manifest.head_token,
      msh10: String(msh10),
      message_sha256: messageSha256,
      capacity_bytes: capacityBytes,
      partition_bytes: partitionBytes,
      global_bytes: globalBytes,
      recorded_at: new Date().toISOString(),
    }, this.events.at(-1)?.event_hash || ZERO_HASH, this.events.length + 1);
    const line = `${canonicalJson(event)}\n`;
    if (globalBytes + Buffer.byteLength(line) > this.store.globalMaxBytes + this.store.gapReserveBytes) {
      throw new SpoolIntegrityError('capacity gap evidence cannot be committed', 'SPOOL_GAP_RESERVE_EXHAUSTED');
    }
    await appendDurable(this.journalFile, line);
    this.events.push(event);
    this.state = stateFromEvents(this.events);
    this.manifest = {
      ...this.manifest,
      journal_event_count: this.events.length,
      journal_tail_hash: event.event_hash,
      local_reconciliation_state: 'reconciliation_required_retention_gap',
      local_reconciliation_reason: 'capacity_refusal',
    };
    await this.writeManifest();
  }

  async recordRefusalEvidence({
    reason, msh10, messageBytes, sourceOccurredAtRaw = null, clockEvidence = null,
  }) {
    return this.exclusive(async () => this.store.capacityExclusive(async () => {
      const body = {
        type: 'gap',
        reason,
        source_partition_ref: this.ref,
        last_committed_position: this.manifest.head_position,
        last_committed_token: this.manifest.head_token,
        msh10: String(msh10),
        message_sha256: sha256(Buffer.from(messageBytes)),
        source_occurred_at_raw: sourceOccurredAtRaw,
        clock_evidence: canonicalize(clockEvidence),
        recorded_at: new Date().toISOString(),
      };
      const event = sealEvent(body, this.events.at(-1)?.event_hash || ZERO_HASH, this.events.length + 1);
      const line = `${canonicalJson(event)}\n`;
      const globalBytes = await this.store.totalBytes();
      if (globalBytes + Buffer.byteLength(line) > this.store.globalMaxBytes + this.store.gapReserveBytes) {
        throw new SpoolIntegrityError('refusal evidence cannot be committed', 'SPOOL_GAP_RESERVE_EXHAUSTED');
      }
      await appendDurable(this.journalFile, line);
      this.events.push(event);
      this.state = stateFromEvents(this.events);
      this.manifest = {
        ...this.manifest,
        journal_event_count: this.events.length,
        journal_tail_hash: event.event_hash,
        local_reconciliation_state: 'reconciliation_required_source_gap',
        local_reconciliation_reason: reason,
      };
      await this.writeManifest();
    }));
  }

  async accept({
    messageBytes, msh10, deviceCodeSnapshot, patientUid, channel,
    sourceOccurredAtRaw, gatewayReceivedAt, clockEvidence, onStage = null,
  }) {
    return this.exclusive(async () => {
      if (this.manifest.local_reconciliation_state) {
        throw new SpoolIntegrityError('partition is held for owner reconciliation', 'PARTITION_RECONCILIATION_REQUIRED');
      }
      await onStage?.('before_append');
      const bytes = Buffer.from(messageBytes);
      const messageSha256 = sha256(bytes);
      const duplicateKey = i09DuplicateKey({
        tenantId: this.manifest.tenant_id,
        deviceRegistryId: this.deviceRegistryId,
        msh10,
      });
      const duplicate = this.state.duplicates.get(duplicateKey);
      if (duplicate) {
        if (duplicate.message_sha256 !== messageSha256) {
          await this.appendEvent({
            type: 'reconciliation',
            state: 'reconciliation_required_source_gap',
            reason: 'duplicate_fingerprint_conflict',
            recorded_at: new Date().toISOString(),
          });
          await this.writeManifest();
          throw new DuplicateConflictError();
        }
        return Object.freeze({ duplicate: true, record: duplicate });
      }
      const sourcePosition = (BigInt(this.manifest.head_position) + 1n).toString();
      if (BigInt(sourcePosition) > POSTGRES_BIGINT_MAX) {
        await this.appendEvent({
          type: 'reconciliation',
          state: 'reconciliation_required_source_gap',
          reason: 'source_position_exhausted',
          recorded_at: new Date().toISOString(),
        });
        await this.writeManifest();
        throw new SpoolIntegrityError('source position space is exhausted', 'SOURCE_POSITION_EXHAUSTED');
      }
      const predecessorToken = this.manifest.head_token;
      const sourceToken = i09SourceToken({
        tenantId: this.manifest.tenant_id,
        sourcePartition: this.manifest.source_partition,
        generation: this.manifest.generation,
        sourcePosition,
        predecessorToken,
        duplicateKey,
        messageSha256,
      });
      const recordBody = {
        schema: I09_GATEWAY_SEQUENCE_CONTRACT,
        tenant_id: this.manifest.tenant_id,
        gateway_registry_id: this.gatewayRegistryId,
        device_registry_id: this.deviceRegistryId,
        device_code_snapshot: String(deviceCodeSnapshot),
        source_partition: this.manifest.source_partition,
        generation: this.manifest.generation,
        source_position: sourcePosition,
        source_token: sourceToken,
        predecessor_token: predecessorToken,
        msh10: String(msh10),
        duplicate_key: duplicateKey,
        message_sha256: messageSha256,
        message_b64: bytes.toString('base64'),
        payload_state: 'present',
        patient_uid: patientUid || null,
        channel: String(channel || ''),
        source_occurred_at_raw: sourceOccurredAtRaw || null,
        gateway_received_at: gatewayReceivedAt,
        clock_evidence: canonicalize(clockEvidence || {}),
        accepted_at: new Date().toISOString(),
        delivery_state: 'pending',
      };
      const record = {
        ...recordBody,
        record_checksum: sha256(Buffer.from(canonicalJson(recordBody), 'utf8')),
      };
      const event = sealEvent({ type: 'accepted', record }, this.events.at(-1)?.event_hash || ZERO_HASH, this.events.length + 1);
      const line = `${canonicalJson(event)}\n`;
      try {
        await this.store.capacityExclusive(async () => {
          const partitionBytes = await this.journalBytes();
          const globalBytes = await this.store.totalBytes();
          let scope = null;
          let capacityBytes = null;
          if (partitionBytes + Buffer.byteLength(line) > this.partitionMaxBytes) {
            scope = 'partition';
            capacityBytes = this.partitionMaxBytes;
          } else if (globalBytes + Buffer.byteLength(line) > this.store.globalMaxBytes) {
            scope = 'global';
            capacityBytes = this.store.globalMaxBytes;
          }
          if (scope) {
            await this.recordGap({ msh10, messageSha256, scope, capacityBytes });
            throw new SpoolFullError(`${scope} spool capacity reached`, { gapRecorded: true, scope });
          }
          await appendDurable(this.journalFile, line);
          await onStage?.('after_journal_before_checkpoint');
        });
      } catch (err) {
        if (!(err instanceof SpoolFullError)) {
          await this.loadJournal();
          await this.repairCheckpointIfNeeded();
        }
        throw err;
      }
      this.events.push(event);
      this.state = stateFromEvents(this.events);
      this.manifest = {
        ...this.manifest,
        head_position: sourcePosition,
        head_token: sourceToken,
        journal_event_count: this.events.length,
        journal_tail_hash: event.event_hash,
      };
      await this.writeManifest();
      if (!await verifyDurableTail(this.journalFile, line, event.event_hash)) {
        throw new SpoolIntegrityError('committed tail could not be verified', 'SPOOL_COMMIT_NOT_VERIFIED');
      }
      await onStage?.('after_commit_before_ack');
      return Object.freeze({ duplicate: false, record });
    });
  }

  pendingAfter(position) {
    return [...this.state.accepted.values()]
      .filter((record) => BigInt(record.source_position) > BigInt(position)
        && !this.state.outcomes.has(record.source_position))
      .sort((a, b) => (BigInt(a.source_position) < BigInt(b.source_position) ? -1 : 1));
  }

  recordAt(position) {
    return this.state.accepted.get(String(position)) || null;
  }

  async recordBackendOutcome(record, resume) {
    return this.exclusive(async () => {
      await this.appendEvent({
        type: 'outcome',
        source_position: record.source_position,
        source_token: record.source_token,
        backend_high_water_position: resume.high_water_position,
        backend_high_water_token: resume.high_water_token,
        backend_recovery_state: resume.recovery_state,
        recorded_at: new Date().toISOString(),
      });
      this.resume = resume;
      this.manifest = {
        ...this.manifest,
        backend_high_water_position: resume.high_water_position,
        backend_high_water_token: resume.high_water_token,
        backend_recovery_state: resume.recovery_state,
        resume_cutoff_position: resume.resume_cutoff_position,
        resume_cutoff_token: resume.resume_cutoff_token,
      };
      await this.writeManifest();
    });
  }

  async compactThrough(position, token) {
    return this.exclusive(async () => {
      const boundary = this.state.accepted.get(String(position));
      if (!boundary || boundary.source_token !== token) {
        throw new SpoolIntegrityError('compaction boundary does not match a durable receipt', 'COMPACTION_BOUNDARY_MISMATCH');
      }
      const observed = this.recordAt(this.manifest.backend_high_water_position);
      const observedToken = observed?.source_token
        || (this.manifest.backend_high_water_position === this.manifest.base_position ? this.manifest.base_token : null);
      if (BigInt(this.manifest.backend_high_water_position) < BigInt(position)
        || observedToken !== this.manifest.backend_high_water_token) {
        throw new SpoolIntegrityError('backend high-water evidence does not authorize compaction', 'COMPACTION_NOT_AUTHORIZED');
      }
      const rewritten = [];
      let prior = ZERO_HASH;
      for (const [index, original] of this.events.entries()) {
        let body = withoutHash(original);
        delete body.event_index;
        delete body.previous_event_hash;
        if (body.type === 'accepted' && BigInt(body.record.source_position) <= BigInt(position)) {
          const { record_checksum: _checksum, ...recordBody } = body.record;
          recordBody.message_b64 = null;
          recordBody.payload_state = 'compacted';
          recordBody.delivery_state = 'backend_confirmed';
          body = {
            ...body,
            record: {
              ...recordBody,
              record_checksum: sha256(Buffer.from(canonicalJson(recordBody), 'utf8')),
            },
          };
        }
        const sealed = sealEvent(body, prior, index + 1);
        rewritten.push(sealed);
        prior = sealed.event_hash;
      }
      await atomicWrite(this.journalFile, rewritten.map((event) => canonicalJson(event)).join('\n') + '\n');
      await this.loadJournal();
      const head = this.derivedHead();
      this.manifest = {
        ...this.manifest,
        head_position: head.position,
        head_token: head.token,
        journal_event_count: this.events.length,
        journal_tail_hash: this.events.at(-1)?.event_hash || ZERO_HASH,
      };
      await this.writeManifest();
    });
  }

  stats() {
    const records = [...this.state.accepted.values()];
    const pending = records.filter((record) => !this.state.outcomes.has(record.source_position));
    const oldest = pending[0]?.accepted_at
      ? Math.max(0, (Date.now() - new Date(pending[0].accepted_at).getTime()) / 1000)
      : 0;
    return {
      depth: pending.length,
      oldestAgeSeconds: oldest,
      headPosition: this.manifest.head_position,
      backendHighWaterPosition: this.manifest.backend_high_water_position,
      recoveryState: this.manifest.backend_recovery_state,
      reconciliationState: this.manifest.local_reconciliation_state,
      reconciliationReason: this.manifest.local_reconciliation_reason,
    };
  }
}

// Legacy live-only sources retain their pre-I09 spool. They never receive or
// emit a recovery envelope and cannot borrow an enrolled partition's marker.
export class NdjsonSpool {
  constructor({ dir, source, maxBytes = 50 * 1024 * 1024 }) {
    this.dir = dir;
    this.source = source;
    this.maxBytes = maxBytes;
    this.file = join(dir, `${source}.ndjson`);
    this.deadFile = join(dir, `${source}.dead.ndjson`);
    this.queue = Promise.resolve();
  }

  // Serializes every mutation. remove()/replace() are read-all/rewrite, so an
  // append landing between the snapshot and the atomicWrite would otherwise
  // be silently discarded. Same primitive as SequencedPartition.exclusive().
  exclusive(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async ensure() {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
  }

  async size() {
    try {
      return (await stat(this.file)).size;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
  }

  async readRaw() {
    try {
      return await readFile(this.file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // A crash mid-append leaves a torn trailing line: bytes after the last
  // newline that never got their terminator (appendDurable always writes the
  // terminator with the line, so a complete file ends in a newline).
  splitTornTail(raw) {
    if (!raw || raw.length === 0 || raw[raw.length - 1] === 0x0a) {
      return { intact: raw || Buffer.alloc(0), torn: null };
    }
    const boundary = raw.lastIndexOf(0x0a);
    return {
      intact: boundary >= 0 ? raw.subarray(0, boundary + 1) : Buffer.alloc(0),
      torn: boundary >= 0 ? raw.subarray(boundary + 1) : raw,
    };
  }

  // Mirror of SequencedPartition.loadJournal's torn-tail handling: quarantine
  // the torn bytes as an evidence file (never silently drop them) and truncate
  // the spool back to its last complete line. Every mutation runs this first,
  // so an append can never concatenate onto a torn line and a rewrite can
  // never discard the torn bytes. The device never got an ACK for the torn
  // message, so its retransmit preserves at-least-once delivery.
  // Callers must hold the mutex.
  async quarantineTornTailUnlocked() {
    const raw = await this.readRaw();
    const { intact, torn } = this.splitTornTail(raw);
    if (!torn) return;
    await atomicWrite(join(this.dir, `${this.source}.torn-tail.${randomUUID()}.evidence`), torn);
    await atomicWrite(this.file, intact);
  }

  async append(entry) {
    return this.exclusive(async () => {
      await this.ensure();
      await this.quarantineTornTailUnlocked();
      const row = {
        id: entry.id || randomUUID(),
        queued_at: entry.queued_at || new Date().toISOString(),
        source: this.source,
        ...entry,
      };
      const line = `${JSON.stringify(row)}\n`;
      if ((await this.size()) + Buffer.byteLength(line) > this.maxBytes) throw new SpoolFullError();
      await appendDurable(this.file, line);
      return row;
    });
  }

  async entries() {
    const raw = await this.readRaw();
    if (!raw) return [];
    // Read-only torn-tail tolerance: parse only complete lines so a torn tail
    // cannot wedge every future read. The torn bytes stay in the file until
    // the next mutation quarantines them with evidence.
    const { intact } = this.splitTornTail(raw);
    return intact.toString('utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  }

  async replaceUnlocked(entries) {
    await atomicWrite(
      this.file,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''),
    );
  }

  async replace(entries) {
    return this.exclusive(async () => {
      await this.quarantineTornTailUnlocked();
      await this.replaceUnlocked(entries);
    });
  }

  async removeUnlocked(id) {
    await this.quarantineTornTailUnlocked();
    await this.replaceUnlocked((await this.entries()).filter((entry) => entry.id !== id));
  }

  async remove(id) {
    return this.exclusive(() => this.removeUnlocked(id));
  }

  async deadLetter(entry, reason) {
    return this.exclusive(async () => {
      await appendDurable(
        this.deadFile,
        `${JSON.stringify({ ...entry, dead_lettered_at: new Date().toISOString(), reason })}\n`,
      );
      await this.removeUnlocked(entry.id);
    });
  }

  async stats() {
    const entries = await this.entries();
    const oldest = entries[0]?.queued_at ? (Date.now() - new Date(entries[0].queued_at).getTime()) / 1000 : 0;
    return { depth: entries.length, oldestAgeSeconds: Math.max(0, oldest) };
  }

  async destroyForTestOnly() {
    await unlink(this.file).catch((err) => { if (err.code !== 'ENOENT') throw err; });
  }
}
