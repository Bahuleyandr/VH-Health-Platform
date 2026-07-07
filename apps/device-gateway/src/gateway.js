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
}

export async function startGateway({ listeners, runtime, metricsPort = 9108 }) {
  await mkdir(runtime.spoolDir, { recursive: true });
  const servers = [];
  for (const listener of listeners) {
    const server = net.createServer((socket) => {
      const reader = new MllpFrameReader();
      const labels = { listener: listener.name };
      mllpConnectionsActive.inc(labels);
      socket.on('data', async (chunk) => {
        for (const message of reader.push(chunk)) {
          const result = await runtime.acceptFrame({
            listener: listener.name,
            sourceIp: socket.remoteAddress?.replace(/^::ffff:/, '') || '',
            message,
          });
          socket.write(frameMessage(result.ack));
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
  return { servers, metricsServer };
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
