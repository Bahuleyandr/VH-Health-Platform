import net from 'node:net';
import { jest } from '@jest/globals';
import { startGateway } from '../src/gateway.js';
import { frameMessage, MllpFrameReader } from '../src/mllpFrameReader.js';

const HL7 = (id) => [
  `MSH|^~\\&|MON-ICU-01|ICU||VHHEALTH|20260707090000||ORU^R01|${id}|P|2.5`,
  'OBX|1|NM|8867-4^Heart rate||118|/min|||||F',
].join('\r');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function stubRuntime(overrides = {}) {
  return {
    initialize: async () => {},
    isReady: () => true,
    startSupervisedDrains: jest.fn(),
    stopSupervisedDrains: jest.fn(),
    acceptFrame: async ({ message }) => {
      const id = String(message).match(/ORU\^R01\|([^|]+)\|/)[1];
      return { ack: `MSH|^~\\&|VHHEALTH|||ICU|20260707090001||ACK|${id}|P|2.5\rMSA|AA|${id}`, ackCode: 'AA' };
    },
    ...overrides,
  };
}

async function startTestGateway(runtime) {
  const started = await startGateway({
    listeners: [{ name: 'order-test', port: 0, host: '127.0.0.1' }],
    runtime,
    metricsPort: 0,
    coldChainIngestPort: null,
  });
  return { started, port: started.servers[0].address().port };
}

async function closeGateway(started) {
  for (const server of [...(started?.servers || []), started?.metricsServer, started?.coldChainServer]) {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

function collectAcks(client) {
  const reader = new MllpFrameReader();
  const acks = [];
  client.on('data', (chunk) => {
    for (const frame of reader.push(chunk)) {
      acks.push(frame.toString('utf8').match(/MSA\|AA\|(\S+)/)[1]);
    }
  });
  return acks;
}

describe('MLLP frame ordering across TCP chunks (GW-4)', () => {
  it('ACKs messages in arrival order even when an earlier message is slower', async () => {
    // First message is slow (backend resolve + fsync), second is fast. The
    // old per-chunk async handler processed the two data events concurrently,
    // so CTRL-B's ACK could overtake CTRL-A's — out-of-order MLLP ACKs that a
    // sequential device misattributes.
    const acceptFrame = jest.fn(async ({ message }) => {
      const id = String(message).match(/ORU\^R01\|([^|]+)\|/)[1];
      await sleep(id === 'CTRL-A' ? 120 : 5);
      return { ack: `MSA|AA|${id}`, ackCode: 'AA' };
    });
    const { started, port } = await startTestGateway(stubRuntime({ acceptFrame }));
    const client = net.connect(port, '127.0.0.1');
    const acks = collectAcks(client);
    try {
      await new Promise((resolve) => client.once('connect', resolve));
      client.write(frameMessage(HL7('CTRL-A')));
      await sleep(20); // separate TCP chunks while CTRL-A is still in flight
      client.write(frameMessage(HL7('CTRL-B')));
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && acks.length < 2) await sleep(10);
      expect(acks).toEqual(['CTRL-A', 'CTRL-B']);
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });

  it('reassembles a frame split across chunks while a previous message is processing', async () => {
    const acceptFrame = jest.fn(async ({ message }) => {
      const id = String(message).match(/ORU\^R01\|([^|]+)\|/)[1];
      await sleep(id === 'CTRL-C' ? 80 : 5);
      return { ack: `MSA|AA|${id}`, ackCode: 'AA' };
    });
    const { started, port } = await startTestGateway(stubRuntime({ acceptFrame }));
    const client = net.connect(port, '127.0.0.1');
    const acks = collectAcks(client);
    try {
      await new Promise((resolve) => client.once('connect', resolve));
      const second = frameMessage(HL7('CTRL-D'));
      client.write(frameMessage(HL7('CTRL-C')));
      await sleep(15);
      // Interleave: half of CTRL-D's frame arrives while CTRL-C is mid-accept.
      client.write(second.subarray(0, Math.floor(second.length / 2)));
      await sleep(15);
      client.write(second.subarray(Math.floor(second.length / 2)));
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && acks.length < 2) await sleep(10);
      expect(acks).toEqual(['CTRL-C', 'CTRL-D']);
      expect(acceptFrame).toHaveBeenCalledTimes(2);
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });
});

describe('graceful shutdown (GW-5)', () => {
  it('finishes in-flight frames, stops accepting, and stops the drain timer', async () => {
    const acceptFrame = jest.fn(async ({ message }) => {
      const id = String(message).match(/ORU\^R01\|([^|]+)\|/)[1];
      await sleep(100);
      return { ack: `MSA|AA|${id}`, ackCode: 'AA' };
    });
    const runtime = stubRuntime({ acceptFrame });
    const { started, port } = await startTestGateway(runtime);
    const client = net.connect(port, '127.0.0.1');
    const acks = collectAcks(client);
    try {
      await new Promise((resolve) => client.once('connect', resolve));
      client.write(frameMessage(HL7('CTRL-Z')));
      await sleep(20); // frame is in flight when shutdown starts

      await started.shutdown({ drainTimeoutMs: 5000 });

      // The in-flight frame completed its durable path and was ACKed before
      // the socket was dropped (destroySoon flushes the final ACK; allow the
      // client loop a moment to receive it).
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && acks.length < 1) await sleep(10);
      expect(acks).toEqual(['CTRL-Z']);
      expect(runtime.stopSupervisedDrains).toHaveBeenCalled();
      for (const server of [started.servers[0], started.metricsServer]) {
        expect(server.listening).toBe(false);
      }
      // New connections are refused after shutdown.
      await expect(new Promise((resolve, reject) => {
        const probe = net.connect(port, '127.0.0.1');
        probe.once('connect', () => { probe.destroy(); resolve('connected'); });
        probe.once('error', reject);
      })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });

  it('is idempotent — repeated calls return the same completed shutdown', async () => {
    const runtime = stubRuntime();
    const { started } = await startTestGateway(runtime);
    try {
      const first = started.shutdown();
      const second = started.shutdown();
      expect(second).toBe(first);
      await first;
      expect(runtime.stopSupervisedDrains).toHaveBeenCalledTimes(1);
    } finally {
      await closeGateway(started);
    }
  });

  it('drops a wedged socket after the drain timeout instead of hanging forever', async () => {
    const acceptFrame = jest.fn(() => new Promise(() => {})); // never resolves
    const { started, port } = await startTestGateway(stubRuntime({ acceptFrame }));
    const client = net.connect(port, '127.0.0.1');
    try {
      await new Promise((resolve) => client.once('connect', resolve));
      client.write(frameMessage(HL7('CTRL-W')));
      await sleep(20);
      const startedAt = Date.now();
      await started.shutdown({ drainTimeoutMs: 50 });
      expect(Date.now() - startedAt).toBeLessThan(3000);
      expect(started.servers[0].listening).toBe(false);
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });
});
