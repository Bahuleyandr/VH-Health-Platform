import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

let serverInstance;
class FakeWebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Set();
    serverInstance = this;
  }

  close(callback) {
    this.emit('close');
    callback?.();
  }
}

jest.unstable_mockModule('ws', () => ({ WebSocketServer: FakeWebSocketServer }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/jwtUtils.js', () => ({
  verifyToken: () => ({
    sub: 'user-1',
    role: 'PATIENT',
    tenant_id: 'tenant-1',
    iat: 1000,
    token_epoch: 3,
    jti: 'access-jti',
  }),
}));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isTokenBlacklisted: jest.fn().mockResolvedValue(false),
  isUserTokensRevoked: jest.fn().mockResolvedValue(false),
}));
jest.unstable_mockModule('../../utils/websocket/channelAuth.js', () => ({
  authorizeChannel: () => ({ allowed: true, reason: 'ok' }),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: () => null,
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordWsBroadcastDropped: jest.fn(),
  recordWsFanoutSubscriberError: jest.fn(),
}));

const {
  closeWebSocket,
  closeWsFanout,
  initWebSocket,
  initWsFanout,
  pushSessionRevoked,
} = await import('../../utils/websocket/wsServer.js');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.send = jest.fn();
    this.close = jest.fn((code, reason) => {
      this.readyState = 3;
      this.emit('close', code, reason);
    });
    this.terminate = jest.fn();
    this.ping = jest.fn();
  }
}

describe('session revocation WebSocket closure', () => {
  afterEach(async () => {
    await closeWsFanout();
    await closeWebSocket();
  });

  it('closes the local socket even when Redis publish rejects asynchronously', async () => {
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.emit('connection', socket, {
      url: '/ws?token=access-token',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    const pub = { publish: jest.fn().mockRejectedValue(new Error('redis down')) };
    const sub = {
      on: jest.fn(),
      off: jest.fn(),
      psubscribe: jest.fn().mockResolvedValue(1),
      punsubscribe: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    initWsFanout({ pub, sub });

    pushSessionRevoked('user-1', { reason: 'force_logout' });

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      event: 'session:revoked',
      data: { reason: 'force_logout' },
    }));
    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    await Promise.resolve();
  });
});
