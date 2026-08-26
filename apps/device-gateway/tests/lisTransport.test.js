import net from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import {
  ACK, AstmFrameReader, ENQ, EOT, frameAstm, NAK,
} from '../src/astmFrameReader.js';
import { frameMessage, MllpFrameReader } from '../src/mllpFrameReader.js';
import {
  createAstmSession,
  LisRuntime,
  lisListenerConfigFromEnv,
  startLisListeners,
  validateLisListener,
  validateLisListenerProfile,
} from '../src/lisTransport.js';

const ANALYZER_TOKEN = 'analyzer-bearer-token-fixture';

const listenerConfig = (overrides = {}) => Object.freeze({
  name: 'chem1',
  port: 3001,
  host: '127.0.0.1',
  protocol: 'astm-e1394',
  tenant_slug: 'vh-main',
  analyzer_code: 'BS-240',
  token: ANALYZER_TOKEN,
  allowed_source_ips: Object.freeze([]),
  max_message_bytes: 1024 * 1024,
  ...overrides,
});

// A realistic ASTM E1394 result message: header, patient, order, result,
// terminator records — one record per frame, each ending with the CR record
// terminator, frame numbers cycling from 1.
const ASTM_RECORDS = [
  'H|\\^&|||Mindray^BS-240^1.0|||||LIS||P|LIS2-A2|20260818093000',
  'P|1||PAT-001||Doe^Jane||19800101|F',
  'O|1|ACC-0001||^^^GLU|R||20260818090000||||||||serum|||||||||||F',
  'R|1|^^^GLU|5.8|mmol/L|3.9^6.1|N||F||analyzer|20260818092500',
  'L|1|N',
];
const ASTM_MESSAGE = ASTM_RECORDS.map((record) => `${record}\r`).join('');
const astmFrames = () => ASTM_RECORDS.map((record, index) => frameAstm({
  fn: (index + 1) % 8,
  text: `${record}\r`,
  last: index === ASTM_RECORDS.length - 1,
}));

const ORU_MESSAGE = [
  'MSH|^~\\&|BS-240|LAB||VHHEALTH|20260818093000||ORU^R01|LIS-CTRL-1|P|2.5.1',
  'PID|1||PAT-001||Doe^Jane',
  'OBR|1|ACC-0001||GLU^Glucose|||20260818090000',
  'OBX|1|NM|GLU^Glucose||5.8|mmol/L|3.9-6.1|N|||F',
].join('\r');

const okBackend = (overrides = {}) => ({
  ingestLabInterface: jest.fn(async () => ({ status: 'ingested' })),
  ingestLabOru: jest.fn(async () => ({ status: 'ingested' })),
  ...overrides,
});

async function tempRuntime(backendClient, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vh-lis-test-'));
  const listener = options.listener || listenerConfig();
  const runtime = new LisRuntime({
    spoolDir: dir,
    backendClient,
    listeners: [listener],
    ...options.runtime,
  });
  return { dir, runtime, listener };
}

// Minimal socket stand-in for driving createAstmSession: captures reply bytes.
function fakeSocket() {
  const written = [];
  return {
    written,
    destroyed: false,
    writable: true,
    write(buf) { written.push(...Buffer.from(buf)); },
  };
}

async function driveAstm(session, reader, wire) {
  for (const event of reader.push(wire)) await session(event);
}

describe('LIS listener configuration', () => {
  it('ships dark: no env var means zero listeners', () => {
    expect(lisListenerConfigFromEnv({})).toEqual([]);
    expect(lisListenerConfigFromEnv({ DEVICE_GATEWAY_LIS_LISTENERS: ' ' })).toEqual([]);
  });

  it('parses a valid listener and resolves the bearer token by env-var name', () => {
    const env = {
      DEVICE_GATEWAY_LIS_LISTENERS: JSON.stringify([{
        name: 'chem1', port: 3001, protocol: 'astm-e1394',
        tenant_slug: 'vh-main', analyzer_code: 'BS-240', token_env: 'LIS_CHEM1_TOKEN',
      }]),
      LIS_CHEM1_TOKEN: ANALYZER_TOKEN,
    };
    const [listener] = lisListenerConfigFromEnv(env);
    expect(listener).toMatchObject({
      name: 'chem1',
      port: 3001,
      host: '0.0.0.0',
      protocol: 'astm-e1394',
      tenant_slug: 'vh-main',
      analyzer_code: 'BS-240',
      token: ANALYZER_TOKEN,
    });
  });

  it('fails closed on unknown fields, bad protocol, and a missing token env var', () => {
    const base = {
      name: 'chem1', port: 3001, protocol: 'astm-e1394',
      tenant_slug: 'vh-main', analyzer_code: 'BS-240', token_env: 'LIS_CHEM1_TOKEN',
    };
    const env = { LIS_CHEM1_TOKEN: ANALYZER_TOKEN };
    expect(() => validateLisListener({ ...base, extra: true }, env)).toThrow(/unknown fields/);
    expect(() => validateLisListener({ ...base, protocol: 'serial' }, env)).toThrow(/protocol/);
    expect(() => validateLisListener(base, {})).toThrow(/LIS_CHEM1_TOKEN is not set/);
    expect(() => validateLisListener({ ...base, analyzer_code: '' }, env)).toThrow(/analyzer_code/);
    expect(() => validateLisListener({ ...base, tenant_slug: '' }, env)).toThrow(/tenant_slug/);
    expect(() => validateLisListener({
      ...base, token_env: 'DEVICE_GATEWAY_BACKEND_TOKEN',
    }, env)).toThrow(/token_env must match/);
    expect(() => validateLisListener({
      ...base, token_env: 'lis_chem1_token',
    }, env)).toThrow(/token_env must match/);
    expect(() => validateLisListener({
      ...base, token_env: 'LIS_1CHEM_TOKEN',
    }, env)).toThrow(/token_env must match/);
  });

  it('normalizes non-secret tenant correlation metadata without resolving a token', () => {
    const profile = validateLisListenerProfile({
      name: 'chem1', port: 3001, protocol: 'astm-e1394',
      tenant_slug: ' VH-Main ', analyzer_code: 'BS-240', token_env: 'LIS_CHEM1_TOKEN',
    });
    expect(profile).toMatchObject({
      tenant_slug: 'vh-main',
      analyzer_code: 'BS-240',
      token_env: 'LIS_CHEM1_TOKEN',
    });
    expect(profile).not.toHaveProperty('token');
  });

  it('rejects duplicate listener names', () => {
    const entry = {
      name: 'chem1', port: 3001, protocol: 'astm-e1394',
      tenant_slug: 'vh-main', analyzer_code: 'BS-240', token_env: 'LIS_CHEM1_TOKEN',
    };
    expect(() => lisListenerConfigFromEnv({
      DEVICE_GATEWAY_LIS_LISTENERS: JSON.stringify([entry, { ...entry, port: 3002 }]),
      LIS_CHEM1_TOKEN: ANALYZER_TOKEN,
    })).toThrow(/unique/);
  });
});

describe('ASTM session conformance', () => {
  it('handshakes ENQ->ACK, ACKs each frame, spools the assembled message, and forwards it to the interface bridge', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      const socket = fakeSocket();
      const session = createAstmSession({ socket, listener, runtime });
      const reader = new AstmFrameReader();

      await driveAstm(session, reader, Buffer.from([ENQ]));
      for (const frame of astmFrames()) await driveAstm(session, reader, frame);
      await driveAstm(session, reader, Buffer.from([EOT]));

      // One ACK for ENQ + one per frame; EOT gets no reply.
      expect(socket.written).toEqual(Array(1 + ASTM_RECORDS.length).fill(ACK));

      // Durably spooled with frames stripped, records CR-separated.
      const entries = await runtime.spoolFor(listener.name).entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        kind: 'astm_e1394',
        listener: 'chem1',
        analyzer_code: 'BS-240',
        message: ASTM_MESSAGE,
      });

      // Drain posts EXACTLY the payload the backend bridge endpoint
      // (POST /api/v1/lab/interface/ingest) accepts, with the per-analyzer
      // bearer token.
      await runtime.drainAll();
      expect(backend.ingestLabInterface).toHaveBeenCalledTimes(1);
      expect(backend.ingestLabInterface).toHaveBeenCalledWith({
        protocol: 'astm_e1394',
        message: ASTM_MESSAGE,
        analyzer_code: 'BS-240',
      }, { token: ANALYZER_TOKEN });
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('NAKs a checksum-corrupt frame and forwards nothing until the clean retransmit', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      const socket = fakeSocket();
      const session = createAstmSession({ socket, listener, runtime });
      const reader = new AstmFrameReader();

      await driveAstm(session, reader, Buffer.from([ENQ]));
      const corrupt = frameAstm({ fn: 1, text: `${ASTM_RECORDS[0]}\r`, last: true });
      corrupt[4] ^= 0x20; // flip a content byte; checksum no longer matches
      await driveAstm(session, reader, corrupt);
      expect(socket.written).toEqual([ACK, NAK]);
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(0);
      await runtime.drainAll();
      expect(backend.ingestLabInterface).not.toHaveBeenCalled();

      // The analyzer retransmits the same frame intact: accepted exactly once.
      await driveAstm(session, reader, frameAstm({ fn: 1, text: `${ASTM_RECORDS[0]}\r`, last: true }));
      await driveAstm(session, reader, Buffer.from([EOT]));
      expect(socket.written).toEqual([ACK, NAK, ACK]);
      const entries = await runtime.spoolFor(listener.name).entries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe(`${ASTM_RECORDS[0]}\r`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('NAKs an out-of-sequence frame and re-ACKs a retransmission of the last accepted frame without double-spooling', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      const socket = fakeSocket();
      const session = createAstmSession({ socket, listener, runtime });
      const reader = new AstmFrameReader();

      await driveAstm(session, reader, Buffer.from([ENQ]));
      // First frame must be FN 1; FN 5 is a sequence fault.
      await driveAstm(session, reader, frameAstm({ fn: 5, text: 'H|\\^&\r', last: false }));
      expect(socket.written).toEqual([ACK, NAK]);

      // Valid final frame, then the SAME frame again (our ACK was lost on the
      // wire): re-ACK and discard, exactly one spool entry.
      const final = frameAstm({ fn: 1, text: 'L|1|N\r', last: true });
      await driveAstm(session, reader, final);
      await driveAstm(session, reader, final);
      expect(socket.written).toEqual([ACK, NAK, ACK, ACK]);
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('NAKs the final frame when the durable append fails, then accepts the retransmit (persist-then-ACK)', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      const socket = fakeSocket();
      const session = createAstmSession({ socket, listener, runtime });
      const reader = new AstmFrameReader();
      const spool = runtime.spoolFor(listener.name);
      const originalAppend = spool.append.bind(spool);
      spool.append = jest.fn(async () => {
        throw Object.assign(new Error('disk fault'), { code: 'EIO' });
      });

      await driveAstm(session, reader, Buffer.from([ENQ]));
      await driveAstm(session, reader, frameAstm({ fn: 1, text: `${ASTM_RECORDS[0]}\r`, last: false }));
      const final = frameAstm({ fn: 2, text: 'L|1|N\r', last: true });
      await driveAstm(session, reader, final);
      expect(socket.written).toEqual([ACK, ACK, NAK]);

      // Disk recovered; the analyzer retransmits ONLY the NAKed final frame.
      // The earlier frame stays accumulated — the assembled message is whole.
      spool.append = originalAppend;
      await driveAstm(session, reader, final);
      await driveAstm(session, reader, Buffer.from([EOT]));
      expect(socket.written).toEqual([ACK, ACK, NAK, ACK]);
      const entries = await spool.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe(`${ASTM_RECORDS[0]}\rL|1|N\r`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('MLLP HL7 ORU listener profile', () => {
  it('ACKs AA only after durable append and forwards to the ORU bridge on drain', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend, {
      listener: listenerConfig({ name: 'hema1', protocol: 'mllp-hl7v2', analyzer_code: 'XN-1000' }),
    });
    try {
      const result = await runtime.acceptHl7Message({ listener, message: ORU_MESSAGE });
      expect(result.ackCode).toBe('AA');
      expect(result.ack).toContain('MSA|AA|LIS-CTRL-1');
      const entries = await runtime.spoolFor('hema1').entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'hl7v2_oru', control_id: 'LIS-CTRL-1' });

      await runtime.drainAll();
      expect(backend.ingestLabOru).toHaveBeenCalledWith(
        { message: ORU_MESSAGE },
        { token: ANALYZER_TOKEN },
      );
      expect(backend.ingestLabInterface).not.toHaveBeenCalled();
      expect(await runtime.spoolFor('hema1').entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers a duplicate MSH-10 with AA Duplicate and no second spool row', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend, {
      listener: listenerConfig({ name: 'hema1', protocol: 'mllp-hl7v2', analyzer_code: 'XN-1000' }),
    });
    try {
      await runtime.acceptHl7Message({ listener, message: ORU_MESSAGE });
      const second = await runtime.acceptHl7Message({ listener, message: ORU_MESSAGE });
      expect(second).toMatchObject({ ackCode: 'AA', duplicate: true });
      expect(await runtime.spoolFor('hema1').entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers AE on a message with no MSH control ID and spools nothing', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend, {
      listener: listenerConfig({ name: 'hema1', protocol: 'mllp-hl7v2', analyzer_code: 'XN-1000' }),
    });
    try {
      const result = await runtime.acceptHl7Message({ listener, message: 'OBX|1|NM|GLU||5.8' });
      expect(result.ackCode).toBe('AE');
      expect(await runtime.spoolFor('hema1').entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('durable spool replay (at-least-once to the backend)', () => {
  it('keeps results spooled through a backend outage and delivers them in order on recovery', async () => {
    let backendUp = false;
    const delivered = [];
    const backend = okBackend({
      ingestLabInterface: jest.fn(async (payload) => {
        if (!backendUp) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
        delivered.push(payload.message.match(/ACC-\d+/)[0]);
        return { status: 'ingested' };
      }),
    });
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      for (const accession of ['ACC-0001', 'ACC-0002']) {
        await runtime.acceptAstmMessage({
          listener,
          message: ASTM_MESSAGE.replace('ACC-0001', accession),
        });
      }
      await runtime.drainAll();
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(2);

      backendUp = true;
      await runtime.drainAll();
      expect(delivered).toEqual(['ACC-0001', 'ACC-0002']);
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('discovers and drains a spool left on disk by a previous process', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      await runtime.acceptAstmMessage({ listener, message: ASTM_MESSAGE });

      const delivered = [];
      const restartedBackend = okBackend({
        ingestLabInterface: jest.fn(async (payload) => {
          delivered.push(payload.analyzer_code);
          return { status: 'ingested' };
        }),
      });
      const restarted = new LisRuntime({
        spoolDir: dir,
        backendClient: restartedBackend,
        listeners: [listener],
      });
      await restarted.drainAll();
      expect(delivered).toEqual(['BS-240']);
      // Idempotent second pass.
      await restarted.drainAll();
      expect(restartedBackend.ingestLabInterface).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('dead-letters a definite backend 4xx with evidence and keeps draining later entries', async () => {
    const delivered = [];
    const backend = okBackend({
      ingestLabInterface: jest.fn(async (payload) => {
        delivered.push(payload.message.match(/ACC-\d+/)[0]);
        if (payload.message.includes('ACC-0002')) {
          throw Object.assign(new Error('specimen not found'), { status: 404 });
        }
        return { status: 'ingested' };
      }),
    });
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      for (const accession of ['ACC-0001', 'ACC-0002', 'ACC-0003']) {
        await runtime.acceptAstmMessage({
          listener,
          message: ASTM_MESSAGE.replace('ACC-0001', accession),
        });
      }
      await runtime.drainAll();
      expect(delivered).toEqual(['ACC-0001', 'ACC-0002', 'ACC-0003']);
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(0);
      const dead = await readFile(runtime.spoolFor(listener.name).deadFile, 'utf8');
      expect(dead).toContain('ACC-0002');
      expect(dead).toContain('lis_4xx');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never dead-letters on 401/403 — credential rotation keeps results queued', async () => {
    const backend = okBackend({
      ingestLabInterface: jest.fn(async () => {
        throw Object.assign(new Error('token expired'), { status: 401 });
      }),
    });
    const { dir, runtime, listener } = await tempRuntime(backend);
    try {
      await runtime.acceptAstmMessage({ listener, message: ASTM_MESSAGE });
      await runtime.drainAll();
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('TCP listener end-to-end', () => {
  async function overTcp(listener, runtime, drive) {
    const openSockets = new Set();
    const socketWork = new Map();
    const [server] = await startLisListeners({
      listeners: [listener],
      runtime,
      socketIdleTimeoutMs: 60_000,
      openSockets,
      socketWork,
    });
    const port = server.address().port;
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const received = [];
    socket.on('data', (chunk) => received.push(...chunk));
    const waitForBytes = async (count) => {
      const deadline = Date.now() + 5000;
      while (received.length < count) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} reply bytes, got ${received.length}`);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
      }
      return received;
    };
    try {
      await drive({ socket, waitForBytes, received });
    } finally {
      socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('carries a full ASTM handshake over a real socket into the spool', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend, {
      listener: listenerConfig({ port: 0 }),
    });
    try {
      await overTcp(listener, runtime, async ({ socket, waitForBytes }) => {
        socket.write(Buffer.from([ENQ]));
        await waitForBytes(1);
        for (const frame of astmFrames()) socket.write(frame);
        const replies = await waitForBytes(1 + ASTM_RECORDS.length);
        socket.write(Buffer.from([EOT]));
        expect(replies).toEqual(Array(1 + ASTM_RECORDS.length).fill(ACK));
      });
      const entries = await runtime.spoolFor(listener.name).entries();
      expect(entries).toHaveLength(1);
      expect(entries[0].message).toBe(ASTM_MESSAGE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('carries an MLLP-framed ORU over a real socket and answers a framed AA', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend, {
      listener: listenerConfig({
        name: 'hema1', port: 0, protocol: 'mllp-hl7v2', analyzer_code: 'XN-1000',
      }),
    });
    try {
      await overTcp(listener, runtime, async ({ socket, waitForBytes, received }) => {
        socket.write(frameMessage(ORU_MESSAGE));
        await waitForBytes(10);
        // Give the framed ACK a moment to arrive fully, then reassemble it.
        const deadline = Date.now() + 5000;
        let acks = [];
        while (acks.length === 0 && Date.now() < deadline) {
          const reader = new MllpFrameReader();
          acks = reader.push(Buffer.from(received));
          if (acks.length === 0) await new Promise((resolve) => { setTimeout(resolve, 5); });
        }
        expect(acks).toHaveLength(1);
        expect(acks[0].toString('utf8')).toContain('MSA|AA|LIS-CTRL-1');
      });
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a connection from outside the source-IP allowlist', async () => {
    const backend = okBackend();
    const { dir, runtime, listener } = await tempRuntime(backend, {
      listener: listenerConfig({ port: 0, allowed_source_ips: Object.freeze(['10.9.9.9']) }),
    });
    try {
      await overTcp(listener, runtime, async ({ socket }) => {
        const closed = new Promise((resolve) => socket.once('close', resolve));
        socket.write(Buffer.from([ENQ]));
        await closed;
      });
      expect(await runtime.spoolFor(listener.name).entries()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
