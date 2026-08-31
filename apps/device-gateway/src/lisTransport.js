import net from 'node:net';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ACK, AstmFrameReader, NAK } from './astmFrameReader.js';
import { rollbackListeningServers } from './listenerLifecycle.js';
import { ack as hl7Ack, extractMeta, messageText } from './hl7.js';
import { errorFields, logEvent } from './logger.js';
import { MllpFrameReader, frameMessage } from './mllpFrameReader.js';
import { NdjsonSpool, SpoolFullError } from './spool.js';
import {
  gatewayForwardFailures,
  gatewaySpoolDepth,
  gatewaySpoolOldestAge,
  lisConnectionsActive,
  lisFrameNaks,
  lisMessagesReceived,
} from './metrics.js';

// LIS analyzer transport: TCP listener profiles that let lab analyzers stream
// results straight into the backend's existing lab closed loop with no
// middleware PC. Two protocols:
//
//   astm-e1394   ASTM E1381/LIS1-A framing (ENQ / STX-frame-checksum / EOT)
//                carrying ASTM E1394 (LIS2-A2) records. Forwarded to
//                POST /api/v1/lab/interface/ingest as
//                { protocol: 'astm_e1394', message, analyzer_code } — the
//                records CR-separated with frames stripped, exactly what
//                labClosedLoopService.parseAstmMessage expects.
//   mllp-hl7v2   MLLP-framed HL7v2 ORU. Forwarded to
//                POST /api/v1/lab/oru/ingest as { message }.
//
// Delivery is at-least-once through the same durable NdjsonSpool machinery
// the bedside-vitals legacy path uses: durable append BEFORE the protocol
// acknowledgement (final-frame ACK for ASTM, AA for MLLP), supervised drain
// to the backend, 4xx dead-letter with evidence, 5xx/timeout retry forever.
//
// SHIPS DARK: no DEVICE_GATEWAY_LIS_LISTENERS -> no listeners, no timers, no
// open ports. Serial (RS-232) analyzers are NOT terminated here — they attach
// through a serial-to-TCP adapter pointed at an astm-e1394 listener port.

const LIS_LISTENER_KEYS = new Set([
  'name', 'port', 'host', 'protocol', 'analyzer_code', 'token_env',
  'tenant_slug', 'allowed_source_ips', 'max_message_bytes',
]);
export const LIS_PROTOCOLS = new Set(['astm-e1394', 'mllp-hl7v2']);
const LIS_TOKEN_ENV_PATTERN = /^LIS_[A-Z][A-Z0-9_]*_TOKEN$/;
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

function normalizeIp(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function validateLisListenerProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LIS listener must be an object');
  }
  const unknown = Object.keys(value).filter((key) => !LIS_LISTENER_KEYS.has(key));
  if (unknown.length) throw new Error(`LIS listener contains unknown fields: ${unknown.join(', ')}`);
  const name = String(value.name || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
    throw new Error('LIS listener name must be 1-64 alphanumeric/underscore/dash characters');
  }
  if (!LIS_PROTOCOLS.has(value.protocol)) {
    throw new Error("LIS listener protocol must be 'astm-e1394' or 'mllp-hl7v2'");
  }
  const analyzerCode = String(value.analyzer_code || '').trim();
  if (!analyzerCode) throw new Error('LIS listener analyzer_code is required');
  const tokenEnv = String(value.token_env || '').trim();
  if (!LIS_TOKEN_ENV_PATTERN.test(tokenEnv)) {
    throw new Error('LIS listener token_env must match LIS_[A-Z][A-Z0-9_]*_TOKEN');
  }
  const tenantSlug = String(value.tenant_slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantSlug)) {
    throw new Error('LIS listener tenant_slug must be a valid tenant slug');
  }
  const port = positiveInteger(value.port, 'LIS listener port');
  if (port > 65535) throw new Error('LIS listener port must be a TCP port number');
  const allowedSourceIps = Array.isArray(value.allowed_source_ips)
    ? value.allowed_source_ips.map(normalizeIp).filter(Boolean)
    : [];
  return Object.freeze({
    name,
    port,
    host: String(value.host || '0.0.0.0'),
    protocol: value.protocol,
    analyzer_code: analyzerCode,
    token_env: tokenEnv,
    tenant_slug: tenantSlug,
    allowed_source_ips: Object.freeze(allowedSourceIps),
    max_message_bytes: value.max_message_bytes === undefined
      ? DEFAULT_MAX_MESSAGE_BYTES
      : positiveInteger(value.max_message_bytes, 'LIS listener max_message_bytes'),
  });
}

export function validateLisListener(value, env = process.env) {
  const profile = validateLisListenerProfile(value);
  const token = String(env[profile.token_env] || '').trim();
  if (!token) throw new Error(`LIS listener token_env ${profile.token_env} is not set`);
  const { token_env: _tokenEnv, ...listener } = profile;
  return Object.freeze({ ...listener, token });
}

// Off by default: the LIS transport starts only when the operator sets
// DEVICE_GATEWAY_LIS_LISTENERS, matching the cold-chain listener's opt-in
// posture. Per-analyzer identity (the tenant-bound machine bearer token for
// the backend bridge) is referenced by env-var NAME so the listener JSON
// stays free of credential material.
export function lisListenerConfigFromEnv(env = process.env) {
  const raw = env.DEVICE_GATEWAY_LIS_LISTENERS;
  if (raw === undefined || String(raw).trim() === '') return [];
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('DEVICE_GATEWAY_LIS_LISTENERS must be an array');
  const listeners = parsed.map((item) => validateLisListener(item, env));
  const names = new Set(listeners.map((item) => item.name));
  if (names.size !== listeners.length) throw new Error('LIS listener names must be unique');
  return listeners;
}

const LIS_SPOOL_PREFIX = 'lis-';

export class LisRuntime {
  constructor({
    spoolDir, backendClient, listeners = [], maxSpoolBytes = 50 * 1024 * 1024,
    controlIdTtlMs = 24 * 60 * 60 * 1000, maxControlIds = 100000,
  }) {
    this.spoolDir = spoolDir;
    this.backendClient = backendClient;
    this.listeners = listeners;
    this.maxSpoolBytes = maxSpoolBytes;
    this.controlIdTtlMs = controlIdTtlMs;
    this.maxControlIds = maxControlIds;
    this.spools = new Map();
    this.controlIds = new Map();
    this.drainTimer = null;
    this.drainInFlight = false;
  }

  listenerByName(name) {
    return this.listeners.find((item) => item.name === name) || null;
  }

  // Spool file names carry the listener name directly (operator config, not
  // wire content), prefixed so LIS spools and any future kinds sharing the
  // directory stay distinguishable and restart discovery can map a file back
  // to its listener without a manifest.
  spoolFor(listenerName) {
    let spool = this.spools.get(listenerName);
    if (!spool) {
      spool = new NdjsonSpool({
        dir: join(this.spoolDir, 'lis'),
        source: `${LIS_SPOOL_PREFIX}${listenerName}`,
        maxBytes: this.maxSpoolBytes,
      });
      this.spools.set(listenerName, spool);
    }
    return spool;
  }

  // Mirror of GatewayRuntime.discoverLegacySpools: register spool files left
  // on disk by a previous process so the supervised drain delivers them even
  // if no analyzer ever reconnects.
  async discoverSpools() {
    let names;
    try {
      names = await readdir(join(this.spoolDir, 'lis'));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      if (!name.startsWith(LIS_SPOOL_PREFIX) || !name.endsWith('.ndjson') || name.endsWith('.dead.ndjson')) continue;
      this.spoolFor(name.slice(LIS_SPOOL_PREFIX.length, -'.ndjson'.length));
    }
  }

  // Same split-read/write dedup discipline as GatewayRuntime: check BEFORE
  // the durable append, consume only AFTER it succeeded, so a failed append
  // never answers a retransmit with a lying "AA Duplicate".
  hasControlId(listenerName, controlId) {
    if (!controlId) return false;
    const key = `${listenerName}:${controlId}`;
    const expires = this.controlIds.get(key);
    if (expires === undefined) return false;
    if (expires < Date.now()) {
      this.controlIds.delete(key);
      return false;
    }
    return true;
  }

  markControlId(listenerName, controlId) {
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
    this.controlIds.set(`${listenerName}:${controlId}`, now + this.controlIdTtlMs);
  }

  // Durable append of one complete ASTM E1394 message (records CR-separated,
  // E1381 frames already stripped by the session). The caller ACKs the final
  // frame only after this resolves — persist-then-ACK, so an append failure
  // NAKs and the analyzer retransmits.
  async acceptAstmMessage({ listener, message }) {
    const entry = await this.spoolFor(listener.name).append({
      kind: 'astm_e1394',
      listener: listener.name,
      analyzer_code: listener.analyzer_code,
      message,
    });
    lisMessagesReceived.inc({ listener: listener.name, protocol: 'astm-e1394', status: 'accepted' });
    await this.refreshSpoolMetrics(this.spoolFor(listener.name));
    return entry;
  }

  // One MLLP-framed HL7 ORU message: durable append then AA, AR on spool
  // full, AE otherwise — the same contract as the bedside MLLP path.
  async acceptHl7Message({ listener, message }) {
    let meta;
    try {
      meta = extractMeta(message);
    } catch (err) {
      return this.hl7Refusal(listener, message, err);
    }
    if (!meta.controlId || !meta.messageType) {
      return this.hl7Refusal(listener, message, Object.assign(new Error('malformed HL7 MSH'), { code: 'MALFORMED_HL7' }));
    }
    try {
      if (this.hasControlId(listener.name, meta.controlId)) {
        lisMessagesReceived.inc({ listener: listener.name, protocol: 'mllp-hl7v2', status: 'duplicate' });
        return { ackCode: 'AA', ack: hl7Ack(message, 'AA', 'Duplicate control ID'), duplicate: true };
      }
      await this.spoolFor(listener.name).append({
        kind: 'hl7v2_oru',
        listener: listener.name,
        analyzer_code: listener.analyzer_code,
        control_id: meta.controlId,
        message: messageText(message),
      });
      this.markControlId(listener.name, meta.controlId);
      lisMessagesReceived.inc({ listener: listener.name, protocol: 'mllp-hl7v2', status: 'accepted' });
      await this.refreshSpoolMetrics(this.spoolFor(listener.name));
      return { ackCode: 'AA', ack: hl7Ack(message, 'AA'), duplicate: false };
    } catch (err) {
      return this.hl7Refusal(listener, message, err);
    }
  }

  hl7Refusal(listener, message, err) {
    const isCapacity = err instanceof SpoolFullError;
    const ackCode = isCapacity ? 'AR' : 'AE';
    lisMessagesReceived.inc({
      listener: listener.name,
      protocol: 'mllp-hl7v2',
      status: isCapacity ? 'rejected' : 'error',
    });
    logEvent(isCapacity ? 'warn' : 'error', 'lis_hl7_refusal', {
      listener: listener.name,
      protocol: 'mllp-hl7v2',
      ack_code: ackCode,
      ...errorFields(err),
    });
    return { ackCode, ack: hl7Ack(message || '', ackCode, err?.code || 'REJECTED'), errorCode: err?.code || 'REJECTED' };
  }

  async drainAll() {
    if (this.drainInFlight) return;
    this.drainInFlight = true;
    try {
      await this.discoverSpools();
      for (const spool of this.spools.values()) {
        try {
          await this.drainSpool(spool);
        } catch (err) {
          gatewayForwardFailures.inc({ reason: 'spool_unreadable' });
          logEvent('error', 'lis_drain_spool_failed', {
            source_ref: spool.source,
            ...errorFields(err),
          });
        }
      }
    } finally {
      this.drainInFlight = false;
    }
  }

  async drainSpool(spool) {
    try {
      await this.drainSpoolInner(spool);
    } finally {
      await this.refreshSpoolMetrics(spool);
    }
  }

  async drainSpoolInner(spool) {
    for (const entry of await spool.entries()) {
      const listener = this.listenerByName(entry.listener);
      if (!listener) {
        // The listener was removed from config (and with it the bridge
        // token). Keep the entries — restoring the config resumes delivery;
        // nothing is silently discarded.
        logEvent('warn', 'lis_drain_listener_unconfigured', {
          source_ref: spool.source,
          listener: entry.listener,
        });
        break;
      }
      try {
        if (entry.kind === 'astm_e1394') {
          await this.backendClient.ingestLabInterface({
            protocol: 'astm_e1394',
            message: entry.message,
            analyzer_code: entry.analyzer_code || listener.analyzer_code,
          }, { token: listener.token });
        } else {
          await this.backendClient.ingestLabOru({
            message: entry.message,
          }, { token: listener.token });
        }
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          // Credential rotation/misconfiguration must never dead-letter lab
          // results: keep them and retry once the operator fixes the token.
          gatewayForwardFailures.inc({ reason: 'credential_refused' });
          logEvent('warn', 'lis_drain_credential_refused', {
            source_ref: spool.source,
            listener: listener.name,
            ...errorFields(err),
          });
          break;
        }
        if (err.status >= 400 && err.status < 500) {
          await spool.deadLetter(entry, 'lis_4xx');
          gatewayForwardFailures.inc({ reason: 'backend_4xx' });
          logEvent('warn', 'lis_drain_dead_letter', {
            source_ref: spool.source,
            entry_id: entry.id,
            reason: 'backend_4xx',
            ...errorFields(err),
          });
          continue;
        }
        gatewayForwardFailures.inc({ reason: err.status >= 500 ? 'backend_5xx' : 'backend_timeout' });
        logEvent('warn', 'lis_drain_delivery_failed', {
          source_ref: spool.source,
          entry_id: entry.id,
          ...errorFields(err),
        });
        break;
      }
      try {
        await spool.remove(entry.id);
      } catch (err) {
        // Backend already ingested this entry; a remove failure is a local
        // spool fault. Stop the pass — the entry is re-delivered next drain
        // (at-least-once, same trade-off as the legacy vitals spool).
        gatewayForwardFailures.inc({ reason: 'spool_remove_failed' });
        logEvent('error', 'lis_spool_remove_failed', {
          source_ref: spool.source,
          entry_id: entry.id,
          ...errorFields(err),
        });
        break;
      }
    }
  }

  async refreshSpoolMetrics(spool) {
    try {
      const stats = await spool.stats();
      gatewaySpoolDepth.set({ scope: 'lis', partition_ref: spool.source }, stats.depth);
      gatewaySpoolOldestAge.set({ scope: 'lis', partition_ref: spool.source }, stats.oldestAgeSeconds);
    } catch {
      // Never let observability break durability semantics.
    }
  }

  startSupervisedDrains(intervalMs = 5000) {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      this.drainAll().catch((err) => {
        logEvent('error', 'lis_supervised_drain_failed', errorFields(err));
      });
    }, intervalMs);
    this.drainTimer.unref?.();
  }

  stopSupervisedDrains() {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
  }
}

function writeByte(socket, byte) {
  if (socket.destroyed || !socket.writable) return;
  socket.write(Buffer.from([byte]));
}

// Per-connection ASTM session: drives ACK/NAK policy and record assembly on
// top of the pure frame reader. Frame numbers cycle 1..7,0,1...; a frame
// re-sent with the LAST accepted number is a retransmission whose ACK was
// lost — acknowledge it again and discard, never double-accumulate.
export function createAstmSession({ socket, listener, runtime }) {
  const state = {
    expectedFn: 1,
    lastAcceptedFn: null,
    chunks: [],
    bytes: 0,
  };
  const resetTransfer = () => {
    state.expectedFn = 1;
    state.lastAcceptedFn = null;
    state.chunks = [];
    state.bytes = 0;
  };
  const nak = (reason) => {
    lisFrameNaks.inc({ listener: listener.name, reason });
    writeByte(socket, NAK);
  };
  return async (event) => {
    if (event.type === 'enq') {
      resetTransfer();
      writeByte(socket, ACK);
      return;
    }
    if (event.type === 'eot') {
      // The message (if any) was persisted at final-frame ACK time; EOT just
      // releases the line and gets no reply.
      resetTransfer();
      return;
    }
    if (event.type === 'reject') {
      nak(event.reason);
      return;
    }
    // event.type === 'frame'
    if (event.fn === state.lastAcceptedFn) {
      writeByte(socket, ACK);
      return;
    }
    if (event.fn !== state.expectedFn) {
      nak('sequence');
      return;
    }
    if (state.bytes + Buffer.byteLength(event.text) > listener.max_message_bytes) {
      nak('message_too_large');
      return;
    }
    if (!event.last) {
      state.chunks.push(event.text);
      state.bytes += Buffer.byteLength(event.text);
      state.lastAcceptedFn = event.fn;
      state.expectedFn = (event.fn + 1) % 8;
      writeByte(socket, ACK);
      return;
    }
    // Final frame: assemble the complete message and persist BEFORE the ACK.
    // On append failure the NAK makes the analyzer retransmit this frame;
    // the accumulated earlier frames stay untouched for the retry.
    const message = state.chunks.concat(event.text).join('');
    try {
      await runtime.acceptAstmMessage({ listener, message });
    } catch (err) {
      lisMessagesReceived.inc({
        listener: listener.name,
        protocol: 'astm-e1394',
        status: err instanceof SpoolFullError ? 'rejected' : 'error',
      });
      logEvent('error', 'lis_astm_append_failed', {
        listener: listener.name,
        protocol: 'astm-e1394',
        ...errorFields(err),
      });
      nak(err instanceof SpoolFullError ? 'spool_full' : 'append_failed');
      return;
    }
    state.chunks = [];
    state.bytes = 0;
    state.lastAcceptedFn = event.fn;
    state.expectedFn = (event.fn + 1) % 8;
    writeByte(socket, ACK);
  };
}

function guardServer(server, name) {
  server.on('error', (err) => {
    console.error(`device-gateway: ${name} server error: ${err?.code || err?.message || err}`);
  });
  return server;
}

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

// Start one TCP server per configured LIS listener. `openSockets` and
// `socketWork` are the caller's graceful-shutdown bookkeeping sets (the same
// ones the bedside MLLP servers use) so in-flight durable appends finish
// before the process exits.
export async function startLisListeners({
  listeners,
  runtime,
  socketIdleTimeoutMs,
  openSockets,
  socketWork,
}) {
  const servers = [];
  try {
    for (const listener of listeners) {
      const server = net.createServer((socket) => {
        const remoteIp = normalizeIp(socket.remoteAddress);
        if (listener.allowed_source_ips.length > 0 && !listener.allowed_source_ips.includes(remoteIp)) {
          logEvent('warn', 'lis_connection_refused_source_ip', { listener: listener.name });
          socket.destroy();
          return;
        }
        const labels = { listener: listener.name };
        lisConnectionsActive.inc(labels);
        openSockets.add(socket);
        socket.on('error', (err) => {
          console.error(`device-gateway: lis socket error listener=${listener.name} remote=${socket.remoteAddress || 'unknown'}: ${err?.code || err?.message || err}`);
          socket.destroy();
        });
        socket.setTimeout(socketIdleTimeoutMs, () => {
          console.error(`device-gateway: lis socket idle timeout after ${socketIdleTimeoutMs}ms listener=${listener.name} remote=${socket.remoteAddress || 'unknown'}`);
          socket.destroy();
        });
        // Same per-socket sequential processing discipline as the MLLP path:
        // parsing is synchronous in arrival order, protocol replies are chained
        // so a fast event can never be answered before a slow earlier one.
        let pending = Promise.resolve();
        let onEvent;
        let reader;
        if (listener.protocol === 'astm-e1394') {
          reader = new AstmFrameReader();
          onEvent = createAstmSession({ socket, listener, runtime });
        } else {
          reader = new MllpFrameReader();
          onEvent = async (message) => {
            const result = await runtime.acceptHl7Message({ listener, message });
            if (socket.destroyed || !socket.writable) return;
            socket.write(frameMessage(result.ack));
          };
        }
        socket.on('data', (chunk) => {
          let events;
          try {
            events = reader.push(chunk);
          } catch {
            socket.destroy();
            return;
          }
          for (const event of events) {
            pending = pending.then(() => onEvent(event).catch(() => socket.destroy()));
          }
          socketWork.set(socket, pending);
        });
        socket.on('close', () => {
          lisConnectionsActive.dec(labels);
          openSockets.delete(socket);
          const work = socketWork.get(socket);
          if (work) {
            work.finally(() => {
              if (socketWork.get(socket) === work) socketWork.delete(socket);
            });
          }
        });
      });
      guardServer(server, `lis:${listener.name}`);
      await listenServer(server, listener.port, listener.host);
      servers.push(server);
    }
    return servers;
  } catch (err) {
    await rollbackListeningServers(servers, openSockets);
    throw err;
  }
}
