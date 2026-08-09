import net from 'node:net';
import { jest } from '@jest/globals';
import { startGateway, socketIdleTimeoutMsFromEnv } from '../src/gateway.js';
import { frameMessage } from '../src/mllpFrameReader.js';

const HL7 = [
  'MSH|^~\\&|MON-ICU-01|ICU||VHHEALTH|20260707090000||ORU^R01|CTRL-G1|P|2.5',
  'OBX|1|NM|8867-4^Heart rate||118|/min|||||F',
].join('\r');

function stubRuntime(overrides = {}) {
  return {
    initialize: async () => {},
    isReady: () => true,
    startSupervisedDrains: () => {},
    acceptFrame: async () => ({ ack: 'MSA|AA|CTRL-G1', ackCode: 'AA' }),
    ...overrides,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTestGateway(options = {}) {
  const started = await startGateway({
    listeners: [{ name: 'guard-test', port: 0, host: '127.0.0.1' }],
    runtime: options.runtime || stubRuntime(),
    metricsPort: 0,
    coldChainIngestPort: null,
    ...options.gatewayOptions,
  });
  const mllpServer = started.servers[0];
  // Capture the server-side socket of the next connection.
  const nextConnection = new Promise((resolve) => mllpServer.once('connection', resolve));
  return { started, mllpServer, port: mllpServer.address().port, nextConnection };
}

async function closeGateway(started) {
  for (const server of [...(started?.servers || []), started?.metricsServer, started?.coldChainServer]) {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

describe('MLLP socket guards', () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('a socket error (ECONNRESET) is logged and destroys the socket without crashing the process', async () => {
    const { started, port, nextConnection } = await startTestGateway();
    const client = net.connect(port, '127.0.0.1');
    try {
      const serverSocket = await nextConnection;

      // Before the guard, this emit was an unhandled 'error' event — an
      // uncaught exception that killed the whole gateway process.
      serverSocket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
      await delay(20);

      expect(serverSocket.destroyed).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNRESET'));
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });

  it('an idle socket is timed out, logged, and destroyed', async () => {
    const { started, port, nextConnection } = await startTestGateway({
      gatewayOptions: { socketIdleTimeoutMs: 40 },
    });
    const client = net.connect(port, '127.0.0.1');
    try {
      const serverSocket = await nextConnection;
      const clientClosed = new Promise((resolve) => client.once('close', resolve));

      await delay(150);

      expect(serverSocket.destroyed).toBe(true);
      await clientClosed;
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('idle timeout'));
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });

  it('skips the ACK write when the peer disconnected during acceptFrame (no write-after-destroy crash)', async () => {
    const acceptFrame = jest.fn(async () => {
      await delay(80);
      return { ack: 'MSA|AA|CTRL-G1', ackCode: 'AA' };
    });
    const { started, port, nextConnection } = await startTestGateway({
      runtime: stubRuntime({ acceptFrame }),
    });
    const client = net.connect(port, '127.0.0.1');
    const received = [];
    client.on('data', (chunk) => received.push(chunk));
    try {
      const serverSocket = await nextConnection;
      const serverSocketClosed = new Promise((resolve) => serverSocket.once('close', resolve));

      await new Promise((resolve) => client.once('connect', resolve));
      client.write(frameMessage(HL7));
      await delay(20);
      // Peer goes away while acceptFrame (spool append + backend call) runs.
      client.destroy();
      await serverSocketClosed;
      await delay(120);

      expect(acceptFrame).toHaveBeenCalledTimes(1);
      expect(serverSocket.destroyed).toBe(true);
      expect(Buffer.concat(received).length).toBe(0);
    } finally {
      client.destroy();
      await closeGateway(started);
    }
  });

  it('server-level error events are logged, not fatal, and a busy port rejects startGateway', async () => {
    const { started } = await startTestGateway();
    try {
      for (const server of [started.servers[0], started.metricsServer]) {
        expect(() => server.emit('error', Object.assign(new Error('boom'), { code: 'EFAKE' }))).not.toThrow();
      }
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('EFAKE'));

      // A listen-time failure (EADDRINUSE) must reject the startGateway
      // promise instead of surfacing as an unhandled 'error' event.
      await expect(startGateway({
        listeners: [{ name: 'dup', port: started.servers[0].address().port, host: '127.0.0.1' }],
        runtime: stubRuntime(),
        metricsPort: 0,
        coldChainIngestPort: null,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await closeGateway(started);
    }
  });

  it('closes listeners already started when a later startup bind fails', async () => {
    const portProbe = net.createServer();
    await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const mllpPort = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));

    const metricsBlocker = net.createServer();
    // Match startGateway's host-unspecified metrics bind. On dual-stack hosts,
    // a blocker bound only to 127.0.0.1 does not conflict with an IPv6 bind.
    await new Promise((resolve) => metricsBlocker.listen(0, resolve));
    const blockedMetricsPort = metricsBlocker.address().port;

    const replacement = net.createServer();
    try {
      await expect(startGateway({
        listeners: [{ name: 'partial-start', port: mllpPort, host: '127.0.0.1' }],
        runtime: stubRuntime(),
        metricsPort: blockedMetricsPort,
        coldChainIngestPort: null,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });

      // The MLLP listener bound successfully before metrics failed. A clean
      // rollback makes its port immediately reusable.
      await expect(new Promise((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen(mllpPort, '127.0.0.1', resolve);
      })).resolves.toBeUndefined();
    } finally {
      if (replacement.listening) await new Promise((resolve) => replacement.close(resolve));
      await new Promise((resolve) => metricsBlocker.close(resolve));
    }
  });
});

describe('socketIdleTimeoutMsFromEnv', () => {
  const KEY = 'DEVICE_GATEWAY_SOCKET_IDLE_TIMEOUT_MS';
  const previous = process.env[KEY];

  afterEach(() => {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
  });

  it('defaults to 5 minutes', () => {
    delete process.env[KEY];
    expect(socketIdleTimeoutMsFromEnv()).toBe(5 * 60 * 1000);
  });

  it('reads a positive integer from the environment', () => {
    process.env[KEY] = '120000';
    expect(socketIdleTimeoutMsFromEnv()).toBe(120000);
  });

  it('rejects a non-positive or non-numeric value', () => {
    for (const bad of ['0', '-5', 'soon', '1.5']) {
      process.env[KEY] = bad;
      expect(() => socketIdleTimeoutMsFromEnv()).toThrow(/positive integer/);
    }
  });
});
