import net from 'node:net';
import http from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ack, extractMeta } from './hl7.js';
import { MllpFrameReader, frameMessage } from './mllpFrameReader.js';
import { NdjsonSpool, SpoolFullError } from './spool.js';
import {
  gatewayAckLatency,
  gatewayDeadLetter,
  gatewayForwardFailures,
  gatewaySpoolDepth,
  gatewaySpoolOldestAge,
  mllpConnectionsActive,
  mllpMessagesReceived,
  serializeMetrics,
} from './metrics.js';

export class GatewayRuntime {
  constructor({ spoolDir, backendClient, maxSpoolBytes = 50 * 1024 * 1024, controlIdTtlMs = 24 * 60 * 60 * 1000 }) {
    this.spoolDir = spoolDir;
    this.backendClient = backendClient;
    this.maxSpoolBytes = maxSpoolBytes;
    this.controlIdTtlMs = controlIdTtlMs;
    this.spools = new Map();
    this.controlIds = new Map();
  }

  spool(source) {
    if (!this.spools.has(source)) {
      this.spools.set(source, new NdjsonSpool({
        dir: this.spoolDir,
        source,
        maxBytes: this.maxSpoolBytes,
      }));
    }
    return this.spools.get(source);
  }

  rememberControlId(source, controlId) {
    if (!controlId) return false;
    const key = `${source}:${controlId}`;
    const now = Date.now();
    for (const [seenKey, expires] of this.controlIds.entries()) {
      if (expires < now) this.controlIds.delete(seenKey);
    }
    if (this.controlIds.has(key)) return true;
    this.controlIds.set(key, now + this.controlIdTtlMs);
    return false;
  }

  async acceptFrame({ listener, sourceIp, message, channel = '' }) {
    const started = process.hrtime.bigint();
    const meta = extractMeta(message);
    const source = meta.sendingApp || meta.sendingFacility || listener || 'unknown';
    try {
      if (!meta.controlId || !meta.messageType) {
        mllpMessagesReceived.inc({ source, status: 'malformed' });
        return { ackCode: 'AE', ack: ack(message, 'AE', 'Malformed HL7 MSH') };
      }
      if (this.rememberControlId(source, meta.controlId)) {
        mllpMessagesReceived.inc({ source, status: 'accepted' });
        return { ackCode: 'AA', duplicate: true, ack: ack(message, 'AA', 'Duplicate control ID') };
      }
      const resolution = await this.backendClient.resolveDevice({
        source_ip: sourceIp,
        device_code: source,
        channel,
      });
      const entry = await this.spool(source).append({
        message,
        device_code: resolution.device?.device_code || source,
        patient_uid: resolution.patient_uid || null,
        channel,
        control_id: meta.controlId,
      });
      await this.refreshSpoolMetrics(source);
      mllpMessagesReceived.inc({ source, status: 'accepted' });
      gatewayAckLatency.observe({}, Number(process.hrtime.bigint() - started) / 1e9);
      return { ackCode: 'AA', ack: ack(message, 'AA'), entry };
    } catch (err) {
      const code = err instanceof SpoolFullError ? 'AR' : 'AE';
      const status = err instanceof SpoolFullError ? 'rejected' : 'malformed';
      mllpMessagesReceived.inc({ source, status });
      return { ackCode: code, ack: ack(message, code, err.code || err.message || 'Rejected') };
    }
  }

  async drainSource(source) {
    const spool = this.spool(source);
    const entries = await spool.entries();
    for (const entry of entries) {
      try {
        await this.backendClient.ingest({
          message: entry.message,
          device_code: entry.device_code,
          patient_uid: entry.patient_uid,
          channel: entry.channel,
        });
        await spool.remove(entry.id);
      } catch (err) {
        if (err.status >= 400 && err.status < 500) {
          await spool.deadLetter(entry, err.body?.message || err.message || '4xx');
          gatewayDeadLetter.inc({});
          gatewayForwardFailures.inc({ reason: 'dead_letter_4xx' });
          continue;
        }
        gatewayForwardFailures.inc({ reason: 'backend_unavailable' });
        break;
      }
    }
    await this.refreshSpoolMetrics(source);
  }

  async refreshSpoolMetrics(source) {
    const stats = await this.spool(source).stats();
    gatewaySpoolDepth.set({ source }, stats.depth);
    gatewaySpoolOldestAge.set({}, stats.oldestAgeSeconds);
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
        sourceIp: req.socket.remoteAddress?.replace(/^::ffff:/, '') || '',
      });
      writeJson(res, 202, { success: true, data: result });
    } catch (err) {
      const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      writeJson(res, status, {
        success: false,
        message: err.message || 'Cold-chain ingest failed',
      });
    }
  });
}

export async function startGateway({ listeners, runtime, metricsPort = 9108, coldChainIngestPort = 8088 }) {
  await mkdir(runtime.spoolDir, { recursive: true });
  const servers = [];
  for (const listener of listeners) {
    const server = net.createServer((socket) => {
      const reader = new MllpFrameReader();
      const labels = { listener: listener.name };
      mllpConnectionsActive.inc(labels);
      socket.on('data', async (chunk) => {
        let messages;
        try {
          messages = reader.push(chunk);
        } catch {
          // Frame exceeded the size bound (Sol Ultra #25) — an abusive/unbounded
          // peer. Drop the connection rather than keep buffering.
          socket.destroy();
          return;
        }
        for (const message of messages) {
          try {
            const result = await runtime.acceptFrame({
              listener: listener.name,
              sourceIp: socket.remoteAddress?.replace(/^::ffff:/, '') || '',
              message,
            });
            socket.write(frameMessage(result.ack));
          } catch {
            // Per-frame processing failure must not take down the listener or
            // surface as an unhandled rejection; the frame is spooled/dropped.
          }
        }
      });
      socket.on('close', () => mllpConnectionsActive.dec(labels));
    });
    await new Promise((resolve) => server.listen(listener.port, listener.host || '0.0.0.0', resolve));
    servers.push(server);
  }
  const metricsServer = http.createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(serializeMetrics());
  });
  await new Promise((resolve) => metricsServer.listen(metricsPort, resolve));
  const coldChainServer = coldChainIngestPort !== null && coldChainIngestPort !== false
    ? createColdChainServer(runtime)
    : null;
  if (coldChainServer) {
    await new Promise((resolve) => coldChainServer.listen(coldChainIngestPort, resolve));
  }
  return { servers, metricsServer, coldChainServer };
}

export function listenerConfigFromEnv() {
  const raw = process.env.DEVICE_GATEWAY_LISTENERS || '[{"name":"default","port":2575,"adapter":"mllp-hl7v2"}]';
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('DEVICE_GATEWAY_LISTENERS must be an array');
  return parsed;
}

export function defaultSpoolDir() {
  return process.env.DEVICE_GATEWAY_SPOOL_DIR || join(process.cwd(), 'spool');
}
