import net from 'node:net';
import http from 'node:http';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ack, extractMeta, messageText } from './hl7.js';
import { errorFields, logEvent } from './logger.js';
import { MllpFrameReader, frameMessage } from './mllpFrameReader.js';
import { startLisListeners } from './lisTransport.js';
import {
  I09_GATEWAY_SEQUENCE_CONTRACT,
  NdjsonSpool,
  SequencedSpoolStore,
  SpoolFullError,
  SpoolIntegrityError,
  opaquePartitionRef,
} from './spool.js';
import {
  gatewayAckLatency,
  gatewayChainHealth,
  gatewayCredentialEvents,
  gatewayForwardFailures,
  gatewayHighWaterLag,
  gatewayInFlight,
  gatewayReconciliation,
  gatewayRecoveryComplete,
  gatewayRecoveryState,
  gatewayRefusals,
  gatewaySpoolCapacity,
  gatewaySpoolDepth,
  gatewaySpoolOldestAge,
  mllpConnectionsActive,
  mllpMessagesReceived,
  serializeMetrics,
} from './metrics.js';

const ENROLLMENT_KEYS = new Set([
  'listener', 'recovery_contract', 'gateway_registry_id', 'device_registry_id',
  'device_code', 'allowed_source_ips', 'partition_capacity_bytes',
  'global_capacity_bytes', 'gap_reserve_bytes', 'clock',
]);
const CLOCK_KEYS = new Set(['source', 'max_skew_ms', 'max_sample_age_ms', 'evidence_path']);
const CLOCK_EVIDENCE_KEYS = new Set(['source', 'status', 'offset_ms', 'sampled_at']);
const OCCURRENCE_RE = /^\d{14}(?:\.\d+)?[+-]\d{4}$/;
const SAFE_REASONS = new Set([
  'backend_4xx', 'backend_5xx', 'backend_timeout', 'backend_ambiguous',
  'capacity_global', 'capacity_partition', 'clock_ambiguous', 'clock_absent',
  'clock_skew', 'credential_refused', 'duplicate_conflict', 'foreign_pvc',
  'generation_mismatch', 'invalid_enrollment', 'marker_missing', 'not_replaying',
  'partition_mismatch', 'source_gap', 'source_identity_refused',
  'source_time_ambiguous', 'spool_corrupt', 'token_mismatch', 'legacy_disabled',
]);

function safeReason(value, fallback = 'spool_corrupt') {
  return SAFE_REASONS.has(value) ? value : fallback;
}

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'AbortError', 'TimeoutError',
]);

// Bounded failure label for legacy drain delivery errors. Only genuine
// timeouts count as backend_timeout; other statusless errors (DNS failures,
// connection resets, programming errors) are labeled backend_unreachable
// instead of being miscounted as timeouts.
function legacyDeliveryFailureReason(err) {
  if (Number.isInteger(err?.status)) return err.status >= 500 ? 'backend_5xx' : 'backend_4xx';
  const code = err?.code || err?.cause?.code || err?.name;
  return TIMEOUT_ERROR_CODES.has(code) ? 'backend_timeout' : 'backend_unreachable';
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function closedObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
  return value;
}

export function validateEnrollment(value) {
  const enrollment = closedObject(value, ENROLLMENT_KEYS, 'I09 enrollment');
  if (enrollment.recovery_contract !== I09_GATEWAY_SEQUENCE_CONTRACT) {
    throw new Error('I09 enrollment recovery_contract must be exact');
  }
  const listener = String(enrollment.listener || '').trim();
  const deviceCode = String(enrollment.device_code || '').trim();
  if (!listener || !deviceCode) throw new Error('I09 enrollment listener and device_code are required');
  const allowedSourceIps = Array.isArray(enrollment.allowed_source_ips)
    ? enrollment.allowed_source_ips.map(normalizeIp).filter(Boolean)
    : [];
  if (allowedSourceIps.length === 0) throw new Error('I09 enrollment allowed_source_ips are required');
  const clock = closedObject(enrollment.clock, CLOCK_KEYS, 'I09 enrollment clock');
  if (!clock.source || !clock.evidence_path) throw new Error('I09 enrollment clock source and evidence_path are required');
  return Object.freeze({
    listener,
    recovery_contract: I09_GATEWAY_SEQUENCE_CONTRACT,
    gateway_registry_id: positiveInteger(enrollment.gateway_registry_id, 'gateway_registry_id'),
    device_registry_id: positiveInteger(enrollment.device_registry_id, 'device_registry_id'),
    device_code: deviceCode,
    allowed_source_ips: Object.freeze(allowedSourceIps),
    partition_capacity_bytes: positiveInteger(enrollment.partition_capacity_bytes, 'partition_capacity_bytes'),
    global_capacity_bytes: positiveInteger(enrollment.global_capacity_bytes, 'global_capacity_bytes'),
    gap_reserve_bytes: positiveInteger(enrollment.gap_reserve_bytes, 'gap_reserve_bytes'),
    clock: Object.freeze({
      source: String(clock.source),
      max_skew_ms: positiveInteger(clock.max_skew_ms, 'clock.max_skew_ms'),
      max_sample_age_ms: positiveInteger(clock.max_sample_age_ms, 'clock.max_sample_age_ms'),
      evidence_path: String(clock.evidence_path),
    }),
  });
}

async function defaultClockEvidenceProvider(enrollment) {
  return JSON.parse(await readFile(enrollment.clock.evidence_path, 'utf8'));
}

function validateClockEvidence(enrollment, evidence, now = Date.now()) {
  if (!evidence) {
    const err = new Error('trusted clock evidence is absent');
    err.code = 'CLOCK_EVIDENCE_ABSENT';
    throw err;
  }
  const unknown = Object.keys(evidence).filter((key) => !CLOCK_EVIDENCE_KEYS.has(key));
  if (unknown.length) {
    const err = new Error('clock evidence contains unknown fields');
    err.code = 'CLOCK_EVIDENCE_AMBIGUOUS';
    throw err;
  }
  if (evidence.source !== enrollment.clock.source || evidence.status !== 'trusted'
    || !Number.isFinite(Number(evidence.offset_ms)) || !evidence.sampled_at) {
    const err = new Error('clock evidence is ambiguous');
    err.code = 'CLOCK_EVIDENCE_AMBIGUOUS';
    throw err;
  }
  if (Math.abs(Number(evidence.offset_ms)) > enrollment.clock.max_skew_ms) {
    const err = new Error('clock evidence exceeds the approved skew');
    err.code = 'CLOCK_EVIDENCE_SKEWED';
    throw err;
  }
  const sampledAt = Date.parse(evidence.sampled_at);
  if (!Number.isFinite(sampledAt) || Math.abs(now - sampledAt) > enrollment.clock.max_sample_age_ms) {
    const err = new Error('clock evidence sample is stale or invalid');
    err.code = 'CLOCK_EVIDENCE_AMBIGUOUS';
    throw err;
  }
  return Object.freeze({
    source: evidence.source,
    status: 'trusted',
    offset_ms: Number(evidence.offset_ms),
    sampled_at: new Date(sampledAt).toISOString(),
  });
}

function safeClockEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return null;
  return Object.fromEntries(
    [...CLOCK_EVIDENCE_KEYS]
      .filter((key) => evidence[key] !== undefined)
      .map((key) => [key, evidence[key]]),
  );
}

export class GatewayRuntime {
  constructor({
    spoolDir, backendClient, maxSpoolBytes = 50 * 1024 * 1024,
    controlIdTtlMs = 24 * 60 * 60 * 1000, maxControlIds = 100000,
    enrollments = [], clockEvidenceProvider = defaultClockEvidenceProvider,
    stageHook = null, allowLegacy = false,
  }) {
    this.spoolDir = spoolDir;
    this.backendClient = backendClient;
    this.maxSpoolBytes = maxSpoolBytes;
    this.controlIdTtlMs = controlIdTtlMs;
    this.maxControlIds = maxControlIds;
    this.legacySpools = new Map();
    this.legacyAcceptQueues = new Map();
    this.controlIds = new Map();
    this.enrollments = enrollments.map(validateEnrollment);
    this.allowLegacy = allowLegacy === true;
    this.clockEvidenceProvider = clockEvidenceProvider;
    this.stageHook = stageHook;
    this.partitionByEnrollment = new Map();
    this.inFlight = new Set();
    this.legacyDrainInFlight = false;
    this.lastRecoveryState = new Map();
    this.drainTimer = null;
    this.startupFault = null;
    this.store = this.createStore();
  }

  createStore() {
    if (this.enrollments.length === 0) return null;
    const global = new Set(this.enrollments.map((item) => item.global_capacity_bytes));
    const reserves = new Set(this.enrollments.map((item) => item.gap_reserve_bytes));
    if (global.size !== 1 || reserves.size !== 1) {
      throw new Error('all I09 enrollments must share one global capacity and gap reserve');
    }
    return new SequencedSpoolStore({
      rootDir: this.spoolDir,
      globalMaxBytes: this.enrollments[0].global_capacity_bytes,
      gapReserveBytes: this.enrollments[0].gap_reserve_bytes,
    });
  }

  enrollmentKey(enrollment) {
    return `${enrollment.listener}:${enrollment.gateway_registry_id}:${enrollment.device_registry_id}`;
  }

  // Keyed by opaque partition ref (not source name) so a spool file recovered
  // from disk after a restart and a live device reconnecting under the same
  // source name resolve to ONE NdjsonSpool instance (whose internal mutex
  // serializes mutations). Two instances on one file would race.
  legacySpoolByRef(ref) {
    let spool = this.legacySpools.get(ref);
    if (!spool) {
      spool = new NdjsonSpool({
        dir: join(this.spoolDir, 'legacy'),
        source: ref,
        maxBytes: this.maxSpoolBytes,
      });
      this.legacySpools.set(ref, spool);
    }
    return spool;
  }

  legacySpool(source) {
    return this.legacySpoolByRef(opaquePartitionRef(`legacy:${source}`));
  }

  // Register every legacy spool file already on disk (from a previous
  // process) so the supervised drain delivers it even when its device never
  // reconnects. Without this, a spool written before a crash/restart was
  // invisible until the exact source name happened to be re-accepted.
  async discoverLegacySpools() {
    const legacyDir = join(this.spoolDir, 'legacy');
    let names;
    try {
      names = await readdir(legacyDir);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      if (!name.endsWith('.ndjson') || name.endsWith('.dead.ndjson')) continue;
      this.legacySpoolByRef(name.slice(0, -'.ndjson'.length));
    }
  }

  async initialize() {
    await mkdir(this.spoolDir, { recursive: true, mode: 0o700 });
    for (const enrollment of this.enrollments) {
      const resume = await this.backendClient.readI09ResumeState({
        gatewayRegistryId: enrollment.gateway_registry_id,
        deviceRegistryId: enrollment.device_registry_id,
      });
      const partition = await this.store.openPartition({
        resumeState: resume,
        gatewayRegistryId: enrollment.gateway_registry_id,
        deviceRegistryId: enrollment.device_registry_id,
        partitionMaxBytes: enrollment.partition_capacity_bytes,
      });
      this.partitionByEnrollment.set(this.enrollmentKey(enrollment), partition);
      gatewaySpoolCapacity.set({ scope: 'partition', partition_ref: partition.ref }, enrollment.partition_capacity_bytes);
      gatewaySpoolCapacity.set({ scope: 'global', partition_ref: '' }, enrollment.global_capacity_bytes);
      await this.refreshPartitionMetrics(partition);
    }
  }

  isReady() {
    if (this.startupFault || this.enrollments.length === 0) return false;
    return this.enrollments.every((enrollment) => this.partitionByEnrollment.has(this.enrollmentKey(enrollment)));
  }

  selectEnrollment(listener, sourceIp, meta) {
    const listenerName = typeof listener === 'string' ? listener : listener?.name;
    const candidates = this.enrollments.filter((item) => item.listener === listenerName);
    if (candidates.length === 0) return { enrollment: null, listenerEnrolled: false };
    const ip = normalizeIp(sourceIp);
    const enrollment = candidates.find((item) => item.device_code === meta.sendingApp
      && item.allowed_source_ips.includes(ip));
    return { enrollment: enrollment || null, listenerEnrolled: true };
  }

  // Dedup is split into a read (hasControlId) and a write (markControlId) so
  // the legacy accept path can check for duplicates BEFORE the durable append
  // but only consume the control ID AFTER the append succeeded. Remembering
  // the ID first (the old rememberControlId) meant a failed append left the
  // ID consumed: the device's retransmit was answered "AA Duplicate" while
  // nothing was ever persisted — a silent vitals drop under a success ACK.
  hasControlId(source, controlId) {
    if (!controlId) return false;
    const key = `${source}:${controlId}`;
    const expires = this.controlIds.get(key);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      this.controlIds.delete(key);
      return false;
    }
    return true;
  }

  markControlId(source, controlId) {
    if (!controlId) return;
    const now = Date.now();
    for (const [seenKey, expires] of this.controlIds.entries()) {
      if (expires < now) this.controlIds.delete(seenKey);
    }
    while (this.controlIds.size >= this.maxControlIds) {
      const oldest = this.controlIds.keys().next().value;
      if (oldest === undefined) break;
      this.controlIds.delete(oldest);
    }
    this.controlIds.set(`${source}:${controlId}`, now + this.controlIdTtlMs);
  }

  async serializeLegacyAccept(source, operation) {
    const previous = this.legacyAcceptQueues.get(source) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.legacyAcceptQueues.set(source, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.legacyAcceptQueues.get(source) === current) {
        this.legacyAcceptQueues.delete(source);
      }
    }
  }

  async acceptFrame({ listener, sourceIp, message, channel = '' }) {
    const started = process.hrtime.bigint();
    let meta;
    try {
      meta = extractMeta(message);
    } catch (err) {
      return this.refusal(message, null, err, 'spool_corrupt');
    }
    const sourceRef = opaquePartitionRef(`ingress:${typeof listener === 'string' ? listener : listener?.name || 'unknown'}`);
    if (!meta.controlId || !meta.messageType) {
      return this.refusal(message, sourceRef, Object.assign(new Error('malformed HL7 MSH'), { code: 'MALFORMED_HL7' }), 'source_identity_refused');
    }
    const selection = this.selectEnrollment(listener, sourceIp, meta);
    try {
      const result = selection.enrollment
        ? await this.acceptEnrolled(selection.enrollment, { message, meta, channel, sourceIp })
        : selection.listenerEnrolled
          ? (() => { throw Object.assign(new Error('source is not enrolled'), { code: 'SOURCE_NOT_ENROLLED' }); })()
          : this.allowLegacy
            ? await this.acceptLegacy({ listener, sourceIp, message, meta, channel })
            : (() => { throw Object.assign(new Error('legacy ingest is disabled'), { code: 'LEGACY_INGEST_DISABLED' }); })();
      const ref = result.partitionRef || sourceRef;
      mllpMessagesReceived.inc({ source_ref: ref, status: 'accepted' });
      gatewayAckLatency.observe({}, Number(process.hrtime.bigint() - started) / 1e9);
      return {
        ackCode: 'AA',
        ack: ack(message, 'AA', result.duplicate ? 'Duplicate control ID' : ''),
        duplicate: result.duplicate,
        entry: result.entry,
      };
    } catch (err) {
      return this.refusal(message, sourceRef, err, this.reasonForError(err));
    }
  }

  refusal(message, sourceRef, err, reason) {
    const isCapacity = err instanceof SpoolFullError;
    if (err?.code === 'SPOOL_GAP_RESERVE_EXHAUSTED'
      || err?.code === 'SPOOL_COMMIT_NOT_VERIFIED') {
      this.startupFault = err.code;
    }
    const ackCode = isCapacity ? 'AR' : 'AE';
    const bounded = safeReason(reason);
    mllpMessagesReceived.inc({ source_ref: sourceRef || 'unresolved', status: isCapacity ? 'rejected' : 'error' });
    gatewayRefusals.inc({ reason: bounded });
    if (isCapacity) gatewayReconciliation.inc({ reason: bounded });
    // The metric label is bounded (unknown failures collapse to
    // 'spool_corrupt'), so preserve the real underlying error identity here.
    logEvent(isCapacity ? 'warn' : 'error', 'mllp_refusal', {
      source_ref: sourceRef || 'unresolved',
      reason: bounded,
      ack_code: ackCode,
      ...errorFields(err),
    });
    return { ackCode, ack: ack(message || '', ackCode, err?.code || 'REJECTED'), errorCode: err?.code || 'REJECTED' };
  }

  reasonForError(err) {
    if (err instanceof SpoolFullError) return err.scope === 'global' ? 'capacity_global' : 'capacity_partition';
    if (err?.code === 'CLOCK_EVIDENCE_ABSENT') return 'clock_absent';
    if (err?.code === 'CLOCK_EVIDENCE_SKEWED') return 'clock_skew';
    if (err?.code === 'CLOCK_EVIDENCE_AMBIGUOUS') return 'clock_ambiguous';
    if (err?.code === 'SOURCE_TIME_AMBIGUOUS') return 'source_time_ambiguous';
    if (err?.code === 'DUPLICATE_FINGERPRINT_CONFLICT') return 'duplicate_conflict';
    if (err?.code === 'FOREIGN_PVC_REFUSED') return 'foreign_pvc';
    if (err?.code === 'RECOVERY_MARKER_MISSING') return 'marker_missing';
    if (err?.code === 'SOURCE_IDENTITY_CHANGED') return 'source_identity_refused';
    if (err?.code === 'SOURCE_NOT_ENROLLED') return 'source_identity_refused';
    if (err?.code === 'LEGACY_INGEST_DISABLED') return 'legacy_disabled';
    return 'spool_corrupt';
  }

  async acceptEnrolled(enrollment, { message, meta, channel, sourceIp }) {
    const partition = this.partitionByEnrollment.get(this.enrollmentKey(enrollment));
    if (!partition) throw new SpoolIntegrityError('enrolled partition did not pass startup handshake', 'RECOVERY_MARKER_MISSING');
    try {
      const resolution = await this.backendClient.resolveDevice({
        source_ip: normalizeIp(sourceIp),
        device_code: enrollment.device_code,
        channel,
      });
      if (Number(resolution?.device?.id) !== enrollment.device_registry_id
        || resolution?.device?.device_code !== enrollment.device_code) {
        throw new SpoolIntegrityError(
          'resolved device identity differs from the enrolled partition',
          'SOURCE_IDENTITY_CHANGED',
        );
      }
      gatewayCredentialEvents.inc({ kind: 'device', status: 'verified' });
    } catch (err) {
      if (err.code === 'DEVICE_AUTH_REFUSED' || err.code === 'SOURCE_IDENTITY_CHANGED') {
        gatewayCredentialEvents.inc({ kind: 'device', status: 'refused' });
        throw err;
      }
      if (err.status && ![401, 403].includes(err.status) && err.status < 500) throw err;
      // The authenticated startup handshake plus the exact source-IP enrollment
      // remain sufficient to spool during backend outage or gateway credential
      // rotation. Delivery stays paused until a fresh authenticated resume read.
      gatewayCredentialEvents.inc({ kind: 'gateway', status: 'spool_only' });
    }
    let rawClockEvidence = null;
    let evidence;
    try {
      if (!OCCURRENCE_RE.test(String(meta.sourceOccurredAtRaw || ''))) {
        const err = new Error('source occurrence is missing or ambiguous');
        err.code = 'SOURCE_TIME_AMBIGUOUS';
        throw err;
      }
      try {
        rawClockEvidence = await this.clockEvidenceProvider(enrollment);
      } catch {
        const err = new Error('trusted clock evidence is absent');
        err.code = 'CLOCK_EVIDENCE_ABSENT';
        throw err;
      }
      evidence = validateClockEvidence(enrollment, rawClockEvidence);
    } catch (err) {
      const reason = err.code === 'SOURCE_TIME_AMBIGUOUS'
        ? 'source_time_ambiguous'
        : 'clock_evidence_untrusted';
      await partition.recordRefusalEvidence({
        reason,
        msh10: meta.controlId,
        messageBytes: Buffer.from(message),
        sourceOccurredAtRaw: meta.sourceOccurredAtRaw,
        clockEvidence: safeClockEvidence(rawClockEvidence),
      });
      throw err;
    }
    const result = await partition.accept({
      messageBytes: Buffer.from(message),
      msh10: meta.controlId,
      deviceCodeSnapshot: enrollment.device_code,
      patientUid: null,
      channel,
      sourceOccurredAtRaw: meta.sourceOccurredAtRaw,
      gatewayReceivedAt: new Date().toISOString(),
      clockEvidence: evidence,
      onStage: this.stageHook,
    });
    await this.refreshPartitionMetrics(partition);
    return { duplicate: result.duplicate, entry: result.record, partitionRef: partition.ref };
  }

  async acceptLegacy({ listener, sourceIp, message, meta, channel }) {
    const source = meta.sendingApp || meta.sendingFacility || (typeof listener === 'string' ? listener : listener?.name) || 'unknown';
    let resolution = null;
    try {
      resolution = await this.backendClient.resolveDevice({ source_ip: sourceIp, device_code: source, channel });
      gatewayCredentialEvents.inc({ kind: 'device', status: 'verified' });
    } catch (err) {
      // A definite backend refusal (any 4xx: unknown device, auth refused)
      // stays a refusal — the device gets AE and nothing is spooled. Anything
      // else (5xx, timeout, network failure, backend outage) must NOT refuse:
      // the durable-recovery-spool commitment is that vitals buffer locally
      // during a backend outage and drain on recovery. Spool with the
      // MSH-derived identity; the drain-time ingest re-resolves the device,
      // so a genuinely unknown device still dead-letters with evidence.
      if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500) throw err;
      if (err?.code === 'DEVICE_AUTH_REFUSED') throw err;
      gatewayCredentialEvents.inc({ kind: 'device', status: 'spool_only' });
      logEvent('warn', 'legacy_accept_backend_unavailable', {
        source_ref: this.legacySpool(source).source,
        reason: legacyDeliveryFailureReason(err),
        ...errorFields(err),
      });
    }
    const deviceKey = resolution?.device?.device_code || source;
    return this.serializeLegacyAccept(source, async () => {
      if (this.hasControlId(deviceKey, meta.controlId)) return { duplicate: true };
      // Persist first, then consume the control ID. The per-source queue keeps
      // this check/append/mark sequence atomic across concurrent sockets. If
      // the append throws, the ID stays unconsumed so a retransmit is accepted.
      const entry = await this.legacySpool(source).append({
        message: messageText(message),
        device_code: deviceKey,
        patient_uid: resolution?.patient_uid || null,
        channel,
        control_id: meta.controlId,
      });
      this.markControlId(deviceKey, meta.controlId);
      await this.refreshLegacySpoolMetrics(this.legacySpool(source));
      return { duplicate: false, entry };
    });
  }

  async drainLegacySource(source) {
    return this.drainLegacySpool(this.legacySpool(source));
  }

  // Drain every known legacy spool: those touched in-process plus any
  // discovered on disk from a previous process. Called from the supervised
  // drain timer so legacy messages buffered during a backend outage are
  // delivered as soon as the backend recovers — the spool is a durable
  // buffer, not a write-only graveyard.
  async drainAllLegacy() {
    if (this.legacyDrainInFlight) return;
    this.legacyDrainInFlight = true;
    try {
      await this.discoverLegacySpools();
      for (const spool of this.legacySpools.values()) {
        try {
          await this.drainLegacySpool(spool);
        } catch (err) {
          // One unreadable spool (e.g. corrupt line) must not skip every
          // later spool on this and all future passes. Its bytes stay on
          // disk for the operator; the healthy sources keep draining.
          gatewayForwardFailures.inc({ reason: 'spool_unreadable' });
          logEvent('error', 'legacy_drain_spool_failed', {
            source_ref: spool.source,
            ...errorFields(err),
          });
        }
      }
    } finally {
      this.legacyDrainInFlight = false;
    }
  }

  async drainLegacySpool(spool) {
    try {
      await this.drainLegacySpoolInner(spool);
    } finally {
      // Refresh depth/age even when the drain broke off (backend outage,
      // unreadable spool): the remaining backlog is exactly what the alerts
      // need to see.
      await this.refreshLegacySpoolMetrics(spool);
    }
  }

  async drainLegacySpoolInner(spool) {
    for (const entry of await spool.entries()) {
      try {
        await this.backendClient.ingest({
          message: entry.message,
          device_code: entry.device_code,
          patient_uid: entry.patient_uid,
          channel: entry.channel,
        });
      } catch (err) {
        if (err.status >= 400 && err.status < 500) {
          await spool.deadLetter(entry, 'legacy_4xx');
          gatewayForwardFailures.inc({ reason: 'backend_4xx' });
          logEvent('warn', 'legacy_drain_dead_letter', {
            source_ref: spool.source,
            entry_id: entry.id,
            reason: 'backend_4xx',
            ...errorFields(err),
          });
          continue;
        }
        const reason = legacyDeliveryFailureReason(err);
        gatewayForwardFailures.inc({ reason });
        logEvent('warn', 'legacy_drain_delivery_failed', {
          source_ref: spool.source,
          entry_id: entry.id,
          reason,
          ...errorFields(err),
        });
        break;
      }
      try {
        await spool.remove(entry.id);
      } catch (err) {
        // The backend already ingested this entry; a remove failure is a
        // local spool fault, not a backend failure, so label it as such and
        // stop the pass. The entry WILL be re-delivered on the next drain —
        // fully preventing that needs a durable delivered-outcome journal for
        // the legacy spool (deeper redesign; enrolled I09 partitions already
        // have one via recordBackendOutcome).
        gatewayForwardFailures.inc({ reason: 'spool_remove_failed' });
        logEvent('error', 'legacy_spool_remove_failed', {
          source_ref: spool.source,
          entry_id: entry.id,
          ...errorFields(err),
        });
        break;
      }
    }
  }

  // Compatibility name for legacy-only callers and existing operational probes.
  async drainSource(source) {
    return this.drainLegacySource(source);
  }

  async readPartitionResume(enrollment, partition) {
    const resume = await this.backendClient.readI09ResumeState({
      gatewayRegistryId: enrollment.gateway_registry_id,
      deviceRegistryId: enrollment.device_registry_id,
    });
    await partition.observeResumeState(resume);
    return resume;
  }

  async drainPartition(enrollment) {
    const partition = this.partitionByEnrollment.get(this.enrollmentKey(enrollment));
    if (!partition || this.inFlight.has(partition.ref)) return;
    this.inFlight.add(partition.ref);
    gatewayInFlight.set({ partition_ref: partition.ref }, 1);
    try {
      let resume;
      try {
        resume = await this.readPartitionResume(enrollment, partition);
      } catch (err) {
        if (err.code === 'EXTERNAL_RECOVERY_MARKER_MISSING') {
          await partition.block('reconciliation_required_missing_marker', 'backend_marker_missing');
          gatewayReconciliation.inc({ reason: 'marker_missing' });
        }
        this.observeBackendError(err);
        return;
      }
      if (partition.manifest.local_reconciliation_state
        || resume.recovery_state !== 'replaying'
        || resume.resume_cutoff_position === null
        || resume.resume_cutoff_token === null) return;
      const cutoff = partition.recordAt(resume.resume_cutoff_position);
      if (!cutoff || cutoff.source_token !== resume.resume_cutoff_token) {
        await partition.block('reconciliation_required_source_gap', 'resume_cutoff_mismatch');
        gatewayReconciliation.inc({ reason: 'token_mismatch' });
        return;
      }
      while (resume.recovery_state === 'replaying') {
        const next = partition.pendingAfter(resume.high_water_position)
          .find((record) => BigInt(record.source_position) <= BigInt(resume.resume_cutoff_position));
        if (!next) break;
        const disposition = await this.deliverOne(enrollment, partition, next);
        if (!disposition?.resume) break;
        resume = disposition.resume;
      }
    } finally {
      this.inFlight.delete(partition.ref);
      gatewayInFlight.set({ partition_ref: partition.ref }, 0);
      await this.refreshPartitionMetrics(partition);
    }
  }

  async deliverOne(enrollment, partition, record) {
    if (record.payload_state !== 'present' || !record.message_b64) {
      await partition.block('reconciliation_required_retention_gap', 'receipt_payload_disagreement');
      gatewayReconciliation.inc({ reason: 'spool_corrupt' });
      return null;
    }
    const payload = {
      message: messageText(Buffer.from(record.message_b64, 'base64')),
      device_code: record.device_code_snapshot,
      patient_uid: record.patient_uid,
      channel: record.channel,
      recovery: {
        schema: I09_GATEWAY_SEQUENCE_CONTRACT,
        interface_family: 'I09',
        arrival_class: 'recovery_backlog',
        tenant_id: record.tenant_id,
        gateway_registry_id: record.gateway_registry_id,
        device_registry_id: record.device_registry_id,
        offset_id: partition.manifest.offset_id,
        source_partition: record.source_partition,
        generation: record.generation,
        source_position: record.source_position,
        source_token: record.source_token,
        predecessor_token: record.predecessor_token,
        msh10: record.msh10,
        duplicate_key: record.duplicate_key,
        message_sha256: record.message_sha256,
        gateway_received_at: record.gateway_received_at,
        clock_evidence: record.clock_evidence,
      },
    };
    let submitted = false;
    try {
      await this.backendClient.ingestI09Recovery(payload);
      submitted = true;
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        gatewayCredentialEvents.inc({ kind: 'gateway', status: 'refused' });
        gatewayForwardFailures.inc({ reason: 'credential_refused' });
        return null;
      }
      if (err.status >= 400 && err.status < 500) {
        if (err.code === 'EXTERNAL_RECOVERY_OFFSET_NOT_REPLAYING') return null;
        const state = err.code === 'EXTERNAL_RECOVERY_MARKER_MISSING'
          ? 'reconciliation_required_missing_marker'
          : 'reconciliation_required_source_gap';
        await partition.block(state, `backend_refusal_${String(err.code || '4xx').slice(0, 80)}`);
        gatewayForwardFailures.inc({ reason: 'backend_4xx' });
        gatewayReconciliation.inc({ reason: 'backend_4xx' });
        return null;
      }
      gatewayForwardFailures.inc({ reason: err.status >= 500 ? 'backend_5xx' : 'backend_ambiguous' });
    }
    let resume;
    try {
      resume = await this.readPartitionResume(enrollment, partition);
    } catch (err) {
      this.observeBackendError(err);
      return null;
    }
    const backendPosition = BigInt(resume.high_water_position);
    const submittedPosition = BigInt(record.source_position);
    if (backendPosition < submittedPosition) {
      if (submitted) gatewayForwardFailures.inc({ reason: 'backend_ambiguous' });
      return null;
    }
    const authoritative = partition.recordAt(resume.high_water_position);
    if (!authoritative || authoritative.source_token !== resume.high_water_token) {
      await partition.block('reconciliation_required_source_gap', 'backend_high_water_token_mismatch');
      gatewayReconciliation.inc({ reason: 'token_mismatch' });
      return null;
    }
    await partition.recordBackendOutcome(record, resume);
    const complete = resume.recovery_state === 'ready'
      && resume.high_water_position === resume.resume_cutoff_position
      && resume.high_water_token === resume.resume_cutoff_token
      && record.source_position === resume.resume_cutoff_position
      && record.source_token === resume.resume_cutoff_token;
    if (complete) await partition.compactThrough(record.source_position, record.source_token);
    gatewayRecoveryComplete.set({ partition_ref: partition.ref }, complete ? 1 : 0);
    return { resume, complete };
  }

  observeBackendError(err) {
    if (err?.status === 401 || err?.status === 403) {
      gatewayCredentialEvents.inc({ kind: 'gateway', status: 'refused' });
      gatewayForwardFailures.inc({ reason: 'credential_refused' });
    } else {
      gatewayForwardFailures.inc({ reason: err?.status >= 500 ? 'backend_5xx' : 'backend_timeout' });
    }
  }

  async refreshPartitionMetrics(partition) {
    if (!partition) return;
    const stats = partition.stats();
    gatewaySpoolDepth.set({ partition_ref: partition.ref }, stats.depth);
    gatewaySpoolOldestAge.set({ partition_ref: partition.ref }, stats.oldestAgeSeconds);
    gatewayChainHealth.set({ partition_ref: partition.ref }, stats.reconciliationState ? 0 : 1);
    gatewayHighWaterLag.set(
      { partition_ref: partition.ref },
      Number(BigInt(stats.headPosition) - BigInt(stats.backendHighWaterPosition)),
    );
    // Zero the previous state's series on transition so at most one state
    // reports 1 per partition (e.g. replaying -> ready).
    const previousState = this.lastRecoveryState.get(partition.ref);
    if (previousState !== undefined && previousState !== stats.recoveryState) {
      gatewayRecoveryState.set({ partition_ref: partition.ref, state: previousState }, 0);
    }
    this.lastRecoveryState.set(partition.ref, stats.recoveryState);
    gatewayRecoveryState.set({ partition_ref: partition.ref, state: stats.recoveryState }, 1);
  }

  // Export legacy spool backlog on the same depth/age gauges the I09
  // partitions use, distinguished by scope="legacy", so the
  // DeviceGatewaySpoolDepthHigh / ...OldestAgeHigh alerts can see legacy
  // depth (NdjsonSpool.stats() previously had no production caller). Metrics
  // are best-effort: an unreadable spool is already surfaced by the drain
  // path (spool_unreadable), so a stats failure must never fail the caller.
  async refreshLegacySpoolMetrics(spool) {
    try {
      const stats = await spool.stats();
      gatewaySpoolDepth.set({ scope: 'legacy', partition_ref: spool.source }, stats.depth);
      gatewaySpoolOldestAge.set({ scope: 'legacy', partition_ref: spool.source }, stats.oldestAgeSeconds);
    } catch {
      // Never let observability break durability semantics.
    }
  }

  startSupervisedDrains(intervalMs = 5000) {
    if (this.drainTimer) return;
    // The timer starts even with zero I09 enrollments: legacy spools always
    // need a drain loop, otherwise messages buffered during a backend outage
    // are never delivered on recovery.
    const drain = async () => {
      for (const enrollment of this.enrollments) await this.drainPartition(enrollment);
      await this.drainAllLegacy();
    };
    this.drainTimer = setInterval(() => {
      drain().catch((err) => {
        logEvent('error', 'supervised_drain_failed', errorFields(err));
      });
    }, intervalMs);
    this.drainTimer.unref?.();
  }

  stopSupervisedDrains() {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }

  async acceptColdChainHttp({ payload, deviceToken, tenantId, sourceIp }) {
    if (!deviceToken) {
      const err = new Error('cold-chain device bearer token is required');
      err.status = 401;
      throw err;
    }
    return this.backendClient.ingestColdChain({
      ...payload,
      source_ip: sourceIp || payload?.source_ip || null,
    }, { deviceToken, tenantId });
  }
}

async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const err = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

function bearerFrom(req, body = {}) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header));
  return match?.[1] || req.headers['x-device-token'] || body.bearer_token || body.sender_bearer_token || null;
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function createColdChainServer(runtime) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/ingest/cold-chain') {
      writeJson(res, 404, { success: false, message: 'Not found' });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = await runtime.acceptColdChainHttp({
        payload: body,
        deviceToken: bearerFrom(req, body),
        tenantId: req.headers['x-tenant-id'] || body.tenant_id || null,
        sourceIp: normalizeIp(req.socket.remoteAddress),
      });
      writeJson(res, 202, { success: true, data: result });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      writeJson(res, status, { success: false, message: err.message || 'Cold-chain ingest failed' });
    }
  });
}

const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function socketIdleTimeoutMsFromEnv() {
  const raw = process.env.DEVICE_GATEWAY_SOCKET_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SOCKET_IDLE_TIMEOUT_MS;
  return positiveInteger(raw, 'DEVICE_GATEWAY_SOCKET_IDLE_TIMEOUT_MS');
}

// Attach a permanent 'error' handler so a runtime server error (post-listen)
// is logged instead of becoming an uncaught exception that kills the gateway.
function guardServer(server, name) {
  server.on('error', (err) => {
    console.error(`device-gateway: ${name} server error: ${err?.code || err?.message || err}`);
  });
  return server;
}

// listen() that rejects on the pre-listen 'error' event (e.g. EADDRINUSE)
// instead of leaking the promise and crashing on an unhandled event.
function listenServer(server, port, host) {
  return new Promise((resolve, reject) => {
    const onListenError = (err) => reject(err);
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.removeListener('error', onListenError);
      resolve();
    });
  });
}

function closeListeningServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startGateway({
  listeners,
  runtime,
  metricsPort = 9108,
  coldChainIngestPort = null,
  socketIdleTimeoutMs = socketIdleTimeoutMsFromEnv(),
  lisListeners = [],
  lisRuntime = null,
}) {
  await runtime.initialize();
  const servers = [];
  let metricsServer = null;
  let coldChainServer = null;
  const openSockets = new Set();
  const socketWork = new Map();
  try {
    for (const listener of listeners) {
      const server = net.createServer((socket) => {
        const reader = new MllpFrameReader();
        const labels = { listener: listener.name };
        mllpConnectionsActive.inc(labels);
        openSockets.add(socket);
        // A TCP-level error on a device connection (ECONNRESET on abrupt
        // monitor disconnect, EPIPE on a failed ACK write) must never crash the
        // gateway: with no listener, 'error' is an uncaught exception. Log and
        // destroy; the device never got its AA, so it retransmits and the
        // control-id dedupe answers AA Duplicate.
        socket.on('error', (err) => {
          console.error(`device-gateway: mllp socket error listener=${listener.name} remote=${socket.remoteAddress || 'unknown'}: ${err?.code || err?.message || err}`);
          socket.destroy();
        });
        // A half-open or wedged connection otherwise holds the frame-reader
        // buffer, the connection slot, and the active-connections gauge
        // forever. Idle destroy only — spooled data is durable and unaffected.
        socket.setTimeout(socketIdleTimeoutMs, () => {
          console.error(`device-gateway: mllp socket idle timeout after ${socketIdleTimeoutMs}ms listener=${listener.name} remote=${socket.remoteAddress || 'unknown'}`);
          socket.destroy();
        });
        // Never rejects: every failure path destroys the socket instead, so
        // the per-socket promise chain below can never wedge on a rejection.
        const processMessage = async (message) => {
          try {
            const result = await runtime.acceptFrame({
              listener,
              sourceIp: normalizeIp(socket.remoteAddress),
              message,
            });
            // The peer can have disconnected while acceptFrame ran (backend
            // HTTP + fsync'd spool append — the durable append correctly
            // happens before any ACK and must stay first). Writing to a
            // destroyed socket would throw/emit 'error'; skip the ACK
            // instead — the device retransmits and dedupe answers.
            if (socket.destroyed || !socket.writable) return;
            socket.write(frameMessage(result.ack));
          } catch {
            socket.destroy();
          }
        };
        // Frame reassembly is synchronous and runs in TCP arrival order, so
        // frames split across chunks reassemble correctly even while earlier
        // messages are still being processed. Message processing is chained
        // per socket: the old `async (chunk)` handler processed each chunk's
        // messages CONCURRENTLY, so a fast message from chunk N+1 could be
        // ACKed before a slow message from chunk N — out-of-order MLLP ACKs
        // that a sequential device (send, await ACK, send) misattributes.
        let pending = Promise.resolve();
        socket.on('data', (chunk) => {
          let messages;
          try {
            messages = reader.push(chunk);
          } catch {
            socket.destroy();
            return;
          }
          for (const message of messages) {
            pending = pending.then(() => processMessage(message));
          }
          socketWork.set(socket, pending);
        });
        socket.on('close', () => {
          mllpConnectionsActive.dec(labels);
          openSockets.delete(socket);
          // A peer can disconnect while acceptFrame is still fsyncing its
          // durable spool entry. Keep that promise visible to shutdown until
          // it settles; deleting it here lets SIGTERM exit mid-persist.
          const work = socketWork.get(socket);
          if (work) {
            work.finally(() => {
              if (socketWork.get(socket) === work) socketWork.delete(socket);
            });
          }
        });
      });
      guardServer(server, `mllp:${listener.name}`);
      await listenServer(server, listener.port, listener.host || '0.0.0.0');
      servers.push(server);
    }
    metricsServer = http.createServer((req, res) => {
      if (req.url === '/readyz') {
        writeJson(res, runtime.isReady() ? 200 : 503, { ready: runtime.isReady() });
        return;
      }
      if (req.url !== '/metrics') {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(serializeMetrics());
    });
    guardServer(metricsServer, 'metrics');
    await listenServer(metricsServer, metricsPort);
    coldChainServer = Number.isFinite(coldChainIngestPort)
      ? guardServer(createColdChainServer(runtime), 'cold-chain')
      : null;
    if (coldChainServer) await listenServer(coldChainServer, coldChainIngestPort);
    // LIS analyzer transport (ships dark: zero configured listeners means
    // zero open ports and zero timers). Its sockets share the same
    // openSockets/socketWork shutdown bookkeeping as the MLLP servers.
    if (lisRuntime && lisListeners.length > 0) {
      const lisServers = await startLisListeners({
        listeners: lisListeners,
        runtime: lisRuntime,
        socketIdleTimeoutMs,
        openSockets,
        socketWork,
      });
      servers.push(...lisServers);
      lisRuntime.startSupervisedDrains(Number(process.env.DEVICE_GATEWAY_DRAIN_INTERVAL_MS || 5000));
    }
    runtime.startSupervisedDrains(Number(process.env.DEVICE_GATEWAY_DRAIN_INTERVAL_MS || 5000));
    // Graceful shutdown (SIGTERM from Kubernetes, SIGINT from an operator):
    // stop the drain timer, stop accepting new connections, let in-flight
    // frames finish their durable append + ACK (bounded), then drop the
    // remaining sockets. Anything not yet durably appended never received AA,
    // so the device retransmits after reconnecting — nothing is lost.
    let shutdownPromise = null;
    const shutdown = ({ drainTimeoutMs = 10000 } = {}) => {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        runtime.stopSupervisedDrains?.();
        lisRuntime?.stopSupervisedDrains?.();
        const closing = [...servers, metricsServer, coldChainServer]
          .filter(Boolean)
          .map((server) => closeListeningServer(server));
        await Promise.race([
          Promise.allSettled([...socketWork.values()]),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, drainTimeoutMs);
            timer.unref?.();
          }),
        ]);
        for (const socket of [...openSockets]) {
          // destroySoon flushes queued writes (the final ACK) before closing;
          // plain destroy() could discard an ACK written microseconds ago.
          if (typeof socket.destroySoon === 'function') socket.destroySoon();
          else socket.destroy();
        }
        await Promise.allSettled(closing);
      })();
      return shutdownPromise;
    };
    return { servers, metricsServer, coldChainServer, shutdown };
  } catch (err) {
    runtime.stopSupervisedDrains?.();
    lisRuntime?.stopSupervisedDrains?.();
    await Promise.allSettled([
      ...servers,
      metricsServer,
      coldChainServer,
    ].map(closeListeningServer));
    throw err;
  }
}

export function listenerConfigFromEnv() {
  const raw = process.env.DEVICE_GATEWAY_LISTENERS || '[{"name":"default","port":2575,"adapter":"mllp-hl7v2"}]';
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('DEVICE_GATEWAY_LISTENERS must be an array');
  return parsed;
}

export function enrollmentConfigFromEnv() {
  const parsed = JSON.parse(process.env.DEVICE_GATEWAY_I09_ENROLLMENTS || '[]');
  if (!Array.isArray(parsed)) throw new Error('DEVICE_GATEWAY_I09_ENROLLMENTS must be an array');
  return parsed.map(validateEnrollment);
}

export function legacyIngestEnabledFromEnv(env = process.env) {
  return env.NODE_ENV !== 'production'
    && String(env.DEVICE_GATEWAY_ALLOW_LEGACY || '').trim().toLowerCase() === 'true';
}

// The cold-chain HTTP listener is opt-in: it starts only when
// DEVICE_GATEWAY_COLD_CHAIN_PORT is explicitly set. The production k8s
// Service/NetworkPolicy expose only MLLP (2575) and metrics (9108), so a
// default-on listener would be dead weight there and an unexpected open
// port everywhere else.
export function coldChainPortFromEnv(env = process.env) {
  const raw = env.DEVICE_GATEWAY_COLD_CHAIN_PORT;
  if (raw === undefined || String(raw).trim() === '') return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('DEVICE_GATEWAY_COLD_CHAIN_PORT must be a TCP port number');
  }
  return port;
}

export function defaultSpoolDir() {
  return process.env.DEVICE_GATEWAY_SPOOL_DIR || join(process.cwd(), 'spool');
}
