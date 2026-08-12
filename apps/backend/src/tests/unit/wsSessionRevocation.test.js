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
  verifyToken: (token) => {
    const sessions = {
      'pre-refresh-access': { sessionFamilyId: 'family-a', stableDeviceId: 'device-a' },
      'browser-ticket': { sessionFamilyId: 'family-a', stableDeviceId: 'device-a', scope: 'ws' },
      'sibling-access': { sessionFamilyId: 'family-b', stableDeviceId: 'device-b' },
      'sibling-ticket': { sessionFamilyId: 'family-b', stableDeviceId: 'device-a', scope: 'ws' },
      'caller-ticket': { sessionFamilyId: 'family-c', stableDeviceId: 'device-a', scope: 'ws' },
      'legacy-ticket': { sessionFamilyId: 'legacy-access', scope: 'ws' },
      'delegated-ticket': {
        sub: 'dependent-1',
        sessionFamilyId: 'family-a',
        stableDeviceId: 'device-a',
        revocationOwnerUid: 'guardian-1',
        scope: 'ws',
      },
      'delegated-sibling-ticket': {
        sub: 'dependent-2',
        sessionFamilyId: 'family-b',
        stableDeviceId: 'device-b',
        revocationOwnerUid: 'guardian-1',
        scope: 'ws',
      },
      'guardian-sibling-ticket': {
        sub: 'guardian-1',
        sessionFamilyId: 'family-b',
        stableDeviceId: 'device-b',
        scope: 'ws',
      },
    };
    return {
      sub: 'user-1',
      id: 42,
      role: 'PATIENT',
      tenant_id: 'tenant-1',
      iat: 1000,
      token_epoch: 3,
      jti: token,
      ...sessions[token],
    };
  },
}));
const isUserTokensRevokedMock = jest.fn().mockResolvedValue(false);
const isDelegatedTupleRevokedMock = jest.fn().mockResolvedValue(false);
let transactionCommitHook = null;
function liveDependent(overrides = {}) {
  return {
    uid: 'dependent-1',
    role: 'PATIENT',
    is_minor: true,
    is_active: true,
    status: 'active',
    is_deleted: false,
    deleted_at: null,
    merged_into_uid: null,
    guardian_role: 'PATIENT',
    guardian_is_active: true,
    guardian_status: 'active',
    guardian_is_deleted: false,
    guardian_deleted_at: null,
    guardian_merged_into_uid: null,
    ...overrides,
  };
}
const queryRawUnsafeMock = jest.fn().mockResolvedValue([liveDependent()]);
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  isTokenBlacklisted: jest.fn().mockResolvedValue(false),
  isDelegatedTupleRevoked: isDelegatedTupleRevokedMock,
  isUserTokensRevoked: isUserTokensRevokedMock,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $transaction: async (fn) => {
      const result = await fn({ $queryRawUnsafe: queryRawUnsafeMock });
      transactionCommitHook?.();
      return result;
    },
  },
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
  pushDelegatedSessionRevoked,
  sendToUser,
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
  beforeEach(() => {
    isUserTokensRevokedMock.mockReset();
    isUserTokensRevokedMock.mockResolvedValue(false);
    isDelegatedTupleRevokedMock.mockReset();
    isDelegatedTupleRevokedMock.mockResolvedValue(false);
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([liveDependent()]);
    transactionCommitHook = null;
  });

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

  it('closes only the socket authenticated by a device-scoped revoked jti', async () => {
    initWebSocket({});
    const revokedSocket = new FakeSocket();
    const siblingSocket = new FakeSocket();
    serverInstance.clients.add(revokedSocket);
    serverInstance.clients.add(siblingSocket);
    serverInstance.emit('connection', revokedSocket, {
      url: '/ws?token=revoked-jti',
      headers: {},
    });
    serverInstance.emit('connection', siblingSocket, {
      url: '/ws?token=sibling-jti',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked('user-1', { reason: 'logout', jti: 'revoked-jti' });

    expect(revokedSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingSocket.close).not.toHaveBeenCalled();
    expect(siblingSocket.readyState).toBe(1);
  });

  it('closes an ordinary-JWT socket by its stable session after access-token rotation', async () => {
    initWebSocket({});
    const rotatedSessionSocket = new FakeSocket();
    const siblingSocket = new FakeSocket();
    serverInstance.clients.add(rotatedSessionSocket);
    serverInstance.clients.add(siblingSocket);
    serverInstance.emit('connection', rotatedSessionSocket, {
      url: '/ws?token=pre-refresh-access',
      headers: {},
    });
    serverInstance.emit('connection', siblingSocket, {
      url: '/ws?token=sibling-access',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked('user-1', {
      reason: 'logout',
      jti: 'post-refresh-access',
      sessionFamilyId: 'family-a',
      stableDeviceId: 'device-a',
    });

    expect(rotatedSessionSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingSocket.close).not.toHaveBeenCalled();
  });

  it('closes a remote browser-ticket family while the caller and a sibling stay open', async () => {
    initWebSocket({});
    const rotatedSessionTicketSocket = new FakeSocket();
    const siblingTicketSocket = new FakeSocket();
    const callerTicketSocket = new FakeSocket();
    serverInstance.clients.add(rotatedSessionTicketSocket);
    serverInstance.clients.add(siblingTicketSocket);
    serverInstance.clients.add(callerTicketSocket);
    serverInstance.emit('connection', rotatedSessionTicketSocket, {
      url: '/ws?token=browser-ticket',
      headers: {},
    });
    serverInstance.emit('connection', siblingTicketSocket, {
      url: '/ws?token=sibling-ticket',
      headers: {},
    });
    serverInstance.emit('connection', callerTicketSocket, {
      url: '/ws?token=caller-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked('user-1', {
      reason: 'logout',
      jti: 'post-refresh-access',
      sessionFamilyId: 'family-a',
      stableDeviceId: 'device-a',
    });

    expect(rotatedSessionTicketSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingTicketSocket.close).not.toHaveBeenCalled();
    expect(callerTicketSocket.close).not.toHaveBeenCalled();
  });

  it('closes ordinary and ticket sockets for a legacy access-token session', async () => {
    initWebSocket({});
    const ordinarySocket = new FakeSocket();
    const ticketSocket = new FakeSocket();
    const siblingSocket = new FakeSocket();
    serverInstance.clients.add(ordinarySocket);
    serverInstance.clients.add(ticketSocket);
    serverInstance.clients.add(siblingSocket);
    serverInstance.emit('connection', ordinarySocket, {
      url: '/ws?token=legacy-access',
      headers: {},
    });
    serverInstance.emit('connection', ticketSocket, {
      url: '/ws?token=legacy-ticket',
      headers: {},
    });
    serverInstance.emit('connection', siblingSocket, {
      url: '/ws?token=sibling-access',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked('user-1', {
      reason: 'logout',
      jti: 'legacy-access',
      sessionFamilyId: 'legacy-access',
    });

    expect(ordinarySocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(ticketSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingSocket.close).not.toHaveBeenCalled();
  });

  it('keeps delegated delivery scoped to the dependent but revokes by guardian session', async () => {
    initWebSocket({});
    const delegatedSocket = new FakeSocket();
    const siblingDependentSocket = new FakeSocket();
    const siblingGuardianSocket = new FakeSocket();
    serverInstance.clients.add(delegatedSocket);
    serverInstance.emit('connection', delegatedSocket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock.mock.calls).toEqual([
      ['guardian-1', 1000, 3],
      ['dependent-1', 1000, undefined],
    ]);
    serverInstance.clients.add(siblingDependentSocket);
    serverInstance.clients.add(siblingGuardianSocket);
    serverInstance.emit('connection', siblingDependentSocket, {
      url: '/ws?token=delegated-sibling-ticket',
      headers: {},
    });
    serverInstance.emit('connection', siblingGuardianSocket, {
      url: '/ws?token=guardian-sibling-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    delegatedSocket.send.mockClear();
    siblingDependentSocket.send.mockClear();
    siblingGuardianSocket.send.mockClear();

    sendToUser('dependent-1', 'clinical:update', { id: 'result-1' });

    expect(delegatedSocket.send).toHaveBeenCalledWith(JSON.stringify({
      event: 'clinical:update',
      data: { id: 'result-1' },
    }));
    expect(siblingDependentSocket.send).not.toHaveBeenCalled();
    expect(siblingGuardianSocket.send).not.toHaveBeenCalled();

    pushSessionRevoked('guardian-1', {
      reason: 'logout',
      jti: 'post-refresh-access',
      sessionFamilyId: 'family-a',
      stableDeviceId: 'device-a',
    });

    expect(delegatedSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingDependentSocket.close).not.toHaveBeenCalled();
    expect(siblingGuardianSocket.close).not.toHaveBeenCalled();
  });

  it('closes only one guardian-dependent tuple while preserving direct and sibling sockets', async () => {
    initWebSocket({});
    const delegatedSocket = new FakeSocket();
    const siblingDependentSocket = new FakeSocket();
    const directGuardianSocket = new FakeSocket();
    for (const socket of [delegatedSocket, siblingDependentSocket, directGuardianSocket]) {
      serverInstance.clients.add(socket);
    }
    serverInstance.emit('connection', delegatedSocket, {
      url: '/ws?token=delegated-ticket', headers: {},
    });
    serverInstance.emit('connection', siblingDependentSocket, {
      url: '/ws?token=delegated-sibling-ticket', headers: {},
    });
    serverInstance.emit('connection', directGuardianSocket, {
      url: '/ws?token=guardian-sibling-ticket', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushDelegatedSessionRevoked('guardian-1', 'dependent-1', {
      reason: 'dependent_unlinked',
    });

    expect(delegatedSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingDependentSocket.close).not.toHaveBeenCalled();
    expect(directGuardianSocket.close).not.toHaveBeenCalled();
  });

  it('rejects a delegated handshake when the authenticated owner was revoked', async () => {
    isUserTokensRevokedMock.mockImplementation(async (uid) => uid === 'guardian-1');
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock.mock.calls).toEqual([
      ['guardian-1', 1000, 3],
    ]);
    expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
  });

  it('rejects a delegated handshake when the effective dependent was revoked', async () => {
    isUserTokensRevokedMock.mockImplementation(async (uid) => uid === 'dependent-1');
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock.mock.calls).toEqual([
      ['guardian-1', 1000, 3],
      ['dependent-1', 1000, undefined],
    ]);
    expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
  });

  it('accepts a delegated handshake only after both revoke-all identities are clean', async () => {
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock.mock.calls).toEqual([
      ['guardian-1', 1000, 3],
      ['dependent-1', 1000, undefined],
    ]);
    expect(isDelegatedTupleRevokedMock).toHaveBeenCalledWith(
      'guardian-1',
      'dependent-1',
      1000,
    );
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      event: 'connected',
      userId: 'dependent-1',
    }));
  });

  it('rejects a replayed delegated ticket after that tuple was unlinked', async () => {
    isDelegatedTupleRevokedMock.mockResolvedValueOnce(true);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Delegated session revoked');
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('registers a delegated socket before the lifecycle lock releases', async () => {
    transactionCommitHook = () => {
      pushSessionRevoked('dependent-1', { reason: 'patient_merge' });
    };
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it.each([
    ['inactive', { is_active: false }],
    ['deleted', { is_deleted: true, deleted_at: new Date().toISOString(), status: 'deleted' }],
    ['merged', { merged_into_uid: 'survivor-1' }],
  ])(
    'rejects a delegated handshake when the dependent is %s',
    async (_label, lifecycle) => {
      queryRawUnsafeMock.mockResolvedValueOnce([liveDependent(lifecycle)]);
      initWebSocket({});
      const socket = new FakeSocket();
      serverInstance.clients.add(socket);

      serverInstance.emit('connection', socket, {
        url: '/ws?token=delegated-ticket',
        headers: {},
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(socket.close).toHaveBeenCalledWith(4001, 'Delegated subject unavailable');
      expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
    },
  );

  it.each([
    ['inactive', { guardian_is_active: false }],
    ['non-active status', { guardian_status: 'suspended' }],
    ['deleted', { guardian_is_deleted: true, guardian_deleted_at: new Date().toISOString(), guardian_status: 'deleted' }],
    ['merged', { guardian_merged_into_uid: 'survivor-1' }],
    ['wrong-role', { guardian_role: 'NURSING_STAFF' }],
  ])(
    'rejects a delegated handshake when the guardian is %s',
    async (_label, lifecycle) => {
      queryRawUnsafeMock.mockResolvedValueOnce([liveDependent(lifecycle)]);
      initWebSocket({});
      const socket = new FakeSocket();
      serverInstance.clients.add(socket);

      serverInstance.emit('connection', socket, {
        url: '/ws?token=delegated-ticket',
        headers: {},
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(socket.close).toHaveBeenCalledWith(4001, 'Delegated subject unavailable');
      expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
    },
  );

  it('checks a direct socket identity once when owner and subject are equal', async () => {
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=access-token',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock.mock.calls).toEqual([
      ['user-1', 1000, 3],
    ]);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('fails a delegated handshake closed when either durable lookup is unavailable', async () => {
    isUserTokensRevokedMock.mockImplementation(async (uid) => {
      if (uid === 'dependent-1') throw new Error('durable store down');
      return false;
    });
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock.mock.calls).toEqual([
      ['guardian-1', 1000, 3],
      ['dependent-1', 1000, undefined],
    ]);
    expect(socket.close).toHaveBeenCalledWith(1013, 'Authentication unavailable');
  });
});
