import { EventEmitter } from 'node:events';
import net from 'node:net';
import { jest } from '@jest/globals';
import {
  closeListeningServer,
  rollbackListeningServers,
  startGateway,
  socketIdleTimeoutMsFromEnv,
} from '../src/gateway.js';
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
    const metricsBlocker = net.createServer();
    // Match startGateway's host-unspecified metrics bind. On dual-stack hosts,
    // a blocker bound only to 127.0.0.1 does not conflict with an IPv6 bind.
    await new Promise((resolve) => metricsBlocker.listen(0, resolve));
    const blockedMetricsPort = metricsBlocker.address().port;

    // Reserve the MLLP port after the metrics blocker so the kernel cannot
    // reassign the just-released probe port to the blocker and make the first
    // (rather than the later) bind fail.
    const portProbe = net.createServer();
    await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
    const mllpPort = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    expect(mllpPort).not.toBe(blockedMetricsPort);

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

describe('listener close lifecycle', () => {
  it('destroys accepted sockets before awaiting listener rollback', async () => {
    const server = net.createServer();
    const serverSocketPromise = new Promise((resolve) => server.once('connection', resolve));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const client = net.connect(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    const serverSocket = await serverSocketPromise;

    try {
      await expect(rollbackListeningServers([server], new Set([serverSocket])))
        .resolves.toEqual([{ status: 'fulfilled', value: undefined }]);
      expect(serverSocket.destroyed).toBe(true);

      const replacement = net.createServer();
      try {
        await expect(new Promise((resolve, reject) => {
          replacement.once('error', reject);
          replacement.listen(port, '127.0.0.1', resolve);
        })).resolves.toBeUndefined();
      } finally {
        if (replacement.listening) await new Promise((resolve) => replacement.close(resolve));
      }
    } finally {
      client.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  });

  it('waits for both the close event and callback and shares an in-flight close', async () => {
    const server = new EventEmitter();
    server.listening = true;
    let closeCallback;
    server.close = jest.fn((callback) => {
      server.listening = false;
      closeCallback = callback;
    });

    const firstClose = closeListeningServer(server);
    const repeatedClose = closeListeningServer(server);
    expect(repeatedClose).toBe(firstClose);
    expect(server.close).toHaveBeenCalledTimes(1);

    let settled = false;
    firstClose.then(() => { settled = true; });
    closeCallback();
    await Promise.resolve();
    expect(settled).toBe(false);

    server.emit('close');
    await expect(firstClose).resolves.toBeUndefined();
    expect(settled).toBe(true);

    server.listening = true;
    const secondClose = closeListeningServer(server);
    expect(secondClose).not.toBe(firstClose);
    expect(server.close).toHaveBeenCalledTimes(2);
    closeCallback();
    server.emit('close');
    await expect(secondClose).resolves.toBeUndefined();
  });

  it('rejects a close callback error and removes its close listener', async () => {
    const server = new EventEmitter();
    const closeError = Object.assign(new Error('listener close failed'), { code: 'ECLOSE' });
    server.listening = true;
    server.close = jest.fn((callback) => callback(closeError));

    await expect(closeListeningServer(server)).rejects.toBe(closeError);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.listenerCount('close')).toBe(0);

    let retryCallback;
    server.listening = true;
    server.close.mockImplementation((callback) => {
      server.listening = false;
      retryCallback = callback;
    });
    const retryClose = closeListeningServer(server);
    retryCallback();
    server.emit('close');
    await expect(retryClose).resolves.toBeUndefined();
    expect(server.close).toHaveBeenCalledTimes(2);
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
