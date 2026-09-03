import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { jest } from '@jest/globals';

let serverInstance;
const DIRECT_USER_UID = '11111111-1111-4111-8111-111111111111';
const DIRECT_TENANT_ID = '22222222-2222-4222-8222-222222222222';
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
      'no-iat-access': { iat: undefined },
      'direct-uuid-access': {
        sub: DIRECT_USER_UID,
        tenant_id: DIRECT_TENANT_ID,
      },
      'uppercase-uuid-access': {
        uid: DIRECT_USER_UID.toUpperCase(),
        tenant_id: DIRECT_TENANT_ID,
      },
      'conflicting-app-identity-access': {
        uid: DIRECT_USER_UID,
        user_id: 'different-app-identity',
        tenant_id: DIRECT_TENANT_ID,
      },
      'hasura-provider-access': {
        sub: 'oidc-provider-subject',
        tenant_id: DIRECT_TENANT_ID,
        'https://hasura.io/jwt/claims': {
          'x-hasura-user-id': DIRECT_USER_UID,
          'x-hasura-default-role': 'patient',
        },
      },
      'snake-provider-access': {
        sub: 'oidc-provider-subject',
        user_id: DIRECT_USER_UID,
        tenant_id: DIRECT_TENANT_ID,
      },
      'camel-provider-access': {
        sub: 'oidc-provider-subject',
        userId: DIRECT_USER_UID,
        tenant_id: DIRECT_TENANT_ID,
      },
      'pre-refresh-access': { sessionFamilyId: 'family-a', stableDeviceId: 'device-a' },
      'browser-ticket': { sessionFamilyId: 'family-a', stableDeviceId: 'device-a', scope: 'ws' },
      'sibling-access': { sessionFamilyId: 'family-b', stableDeviceId: 'device-b' },
      'sibling-ticket': { sessionFamilyId: 'family-b', stableDeviceId: 'device-a', scope: 'ws' },
      'caller-ticket': { sessionFamilyId: 'family-c', stableDeviceId: 'device-a', scope: 'ws' },
      'legacy-ticket': { sessionFamilyId: 'legacy-access', scope: 'ws' },
      'legacy-correlated-ticket': { accessSessionJti: 'legacy-access', scope: 'ws' },
      'legacy-correlated-sibling': { accessSessionJti: 'legacy-sibling', scope: 'ws' },
      'family-precedence-ticket': {
        accessSessionJti: 'legacy-access',
        sessionFamilyId: 'family-b',
        stableDeviceId: 'device-a',
        scope: 'ws',
      },
      'legacy-correlated-delegated': {
        sub: 'dependent-1',
        accessSessionJti: 'legacy-access',
        revocationOwnerUid: 'guardian-1',
        scope: 'ws',
      },
      'legacy-correlated-delegated-sibling': {
        sub: 'dependent-2',
        accessSessionJti: 'legacy-sibling',
        revocationOwnerUid: 'guardian-1',
        scope: 'ws',
      },
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
const isSubjectDelegationRevokedMock = jest.fn().mockResolvedValue(false);
let transactionCommitHook = null;
let transactionCommitError = null;
function liveDependent(overrides = {}) {
  return {
    uid: 'dependent-1',
    role: 'PATIENT',
    is_minor: true,
    is_minor_now: true,
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
function liveDirectUser(overrides = {}) {
  return {
    uid: DIRECT_USER_UID,
    tenant_id: DIRECT_TENANT_ID,
    is_active: true,
    status: 'active',
    is_deleted: false,
    deleted_at: null,
    merged_into_uid: null,
    ...overrides,
  };
}
function liveDirectAdmin(overrides = {}) {
  return {
    uid: DIRECT_USER_UID,
    tenant_id: null,
    is_active: true,
    status: 'active',
    ...overrides,
  };
}
const isTokenBlacklistedMock = jest.fn().mockResolvedValue(false);
const queryRawUnsafeMock = jest.fn().mockResolvedValue([liveDependent()]);
const executeRawUnsafeMock = jest.fn().mockResolvedValue(0);
const withAuthRevocationLocksMock = jest.fn(async (client, _keys, fn) => fn(client));
jest.unstable_mockModule('../../utils/tokenBlacklist.js', () => ({
  authRevocationLockKeys: ({ identityUids = [], jtis = [], tupleKeys = [] } = {}) => (
    [...new Set([
      ...identityUids.filter(Boolean).map((uid) => `vh:auth:identity:${String(uid).toLowerCase()}`),
      ...jtis.filter(Boolean).map((jti) => `vh:auth:jti:${String(jti)}`),
      ...tupleKeys.filter(Boolean).map((tuple) => `vh:auth:tuple:${String(tuple).toLowerCase()}`),
    ])].sort()
  ),
  isTokenBlacklisted: isTokenBlacklistedMock,
  isDelegatedTupleRevoked: isDelegatedTupleRevokedMock,
  isSubjectDelegationRevoked: isSubjectDelegationRevokedMock,
  isUserTokensRevoked: isUserTokensRevokedMock,
  withAuthRevocationLocks: withAuthRevocationLocksMock,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $executeRawUnsafe: executeRawUnsafeMock,
    $queryRawUnsafe: queryRawUnsafeMock,
    $transaction: async (fn) => {
      const result = await fn({
        $executeRawUnsafe: executeRawUnsafeMock,
        $queryRawUnsafe: queryRawUnsafeMock,
      });
      const commitHook = transactionCommitHook;
      transactionCommitHook = null;
      const commitError = transactionCommitError;
      transactionCommitError = null;
      if (commitError) throw commitError;
      commitHook?.();
      return result;
    },
  },
}));
jest.unstable_mockModule('../../utils/websocket/channelAuth.js', () => ({
  authorizeChannel: () => ({ allowed: true, reason: 'ok' }),
  parsePatientChannel: () => null,
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  getCurrentTenantId: () => null,
}));
jest.unstable_mockModule('../../observability/reliabilityMetrics.js', () => ({
  recordWsBroadcastDropped: jest.fn(),
  recordWsFanoutSubscriberError: jest.fn(),
}));

const {
  broadcast,
  closeWebSocket,
  closeWsFanout,
  initWebSocket,
  initWsFanout,
  pushSessionRevoked,
  pushDelegatedSessionRevoked,
  sendToUser,
  WS_REMOTE_REVOCATION_CLOSE_BOUND_MS,
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
    isTokenBlacklistedMock.mockReset();
    isTokenBlacklistedMock.mockResolvedValue(false);
    isUserTokensRevokedMock.mockReset();
    isUserTokensRevokedMock.mockResolvedValue(false);
    isDelegatedTupleRevokedMock.mockReset();
    isDelegatedTupleRevokedMock.mockResolvedValue(false);
    isSubjectDelegationRevokedMock.mockReset();
    isSubjectDelegationRevokedMock.mockResolvedValue(false);
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([liveDependent()]);
    executeRawUnsafeMock.mockClear();
    withAuthRevocationLocksMock.mockReset();
    withAuthRevocationLocksMock.mockImplementation(async (client, _keys, fn) => fn(client));
    transactionCommitHook = null;
    transactionCommitError = null;
  });

  afterEach(async () => {
    await closeWsFanout();
    await closeWebSocket();
  });

  it('refuses a direct handshake when the shared identity predicate denies the subject', async () => {
    isUserTokensRevokedMock.mockResolvedValueOnce(true);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=access-token',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock).toHaveBeenCalledWith('user-1', 1000, 3);
    expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('does not let a no-iat direct token bypass the shared identity predicate', async () => {
    isUserTokensRevokedMock.mockResolvedValueOnce(true);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=no-iat-access',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock).toHaveBeenCalledWith('user-1', undefined, 3);
    expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
    expect(socket.send).not.toHaveBeenCalled();
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
    await initWsFanout({ pub, sub });

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

  it('closes direct and delegated tickets correlated to a selectorless legacy access jti', async () => {
    initWebSocket({});
    const directSocket = new FakeSocket();
    const delegatedSocket = new FakeSocket();
    const directSiblingSocket = new FakeSocket();
    const delegatedSiblingSocket = new FakeSocket();
    for (const socket of [
      directSocket,
      delegatedSocket,
      directSiblingSocket,
      delegatedSiblingSocket,
    ]) {
      serverInstance.clients.add(socket);
    }
    serverInstance.emit('connection', directSocket, {
      url: '/ws?token=legacy-correlated-ticket', headers: {},
    });
    serverInstance.emit('connection', delegatedSocket, {
      url: '/ws?token=legacy-correlated-delegated', headers: {},
    });
    serverInstance.emit('connection', directSiblingSocket, {
      url: '/ws?token=legacy-correlated-sibling', headers: {},
    });
    serverInstance.emit('connection', delegatedSiblingSocket, {
      url: '/ws?token=legacy-correlated-delegated-sibling', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked('user-1', { reason: 'session_revoked', jti: 'legacy-access' });
    pushSessionRevoked('guardian-1', { reason: 'session_revoked', jti: 'legacy-access' });

    expect(directSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(delegatedSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(directSiblingSocket.close).not.toHaveBeenCalled();
    expect(delegatedSiblingSocket.close).not.toHaveBeenCalled();
  });

  it('does not use access-jti correlation when a stable session family selector is present', async () => {
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.emit('connection', socket, {
      url: '/ws?token=family-precedence-ticket', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked('user-1', {
      reason: 'session_revoked',
      jti: 'legacy-access',
      sessionFamilyId: 'family-a',
      stableDeviceId: 'device-a',
    });

    expect(socket.close).not.toHaveBeenCalled();
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
      ['guardian-1', 1000, 3, { client: expect.any(Object) }],
      ['guardian-1', 1000, 3, { client: expect.any(Object) }],
    ]);
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith('dependent-1', 1000);
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
    await new Promise((resolve) => setImmediate(resolve));

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
    isSubjectDelegationRevokedMock.mockResolvedValue(true);
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
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith('dependent-1', 1000);
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
      ['guardian-1', 1000, 3, { client: expect.any(Object) }],
      ['guardian-1', 1000, 3, { client: expect.any(Object) }],
    ]);
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith('dependent-1', 1000);
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

  it('registers a direct UUID socket before the identity lock releases', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    transactionCommitHook = () => {
      pushSessionRevoked(DIRECT_USER_UID, { reason: 'admin_deactivated' });
    };
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(
      /FROM users[\s\S]*WHERE uid = \$1::uuid[\s\S]*FOR SHARE/,
    );
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(
      /FROM admins[\s\S]*WHERE uid = \$1::uuid[\s\S]*FOR SHARE/,
    );
    expect(withAuthRevocationLocksMock.mock.calls[0][1]).toEqual([
      `vh:auth:identity:${DIRECT_USER_UID}`,
      'vh:auth:jti:direct-uuid-access',
    ]);
    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('takes direct identity advisory locks before row share locks', async () => {
    const events = [];
    withAuthRevocationLocksMock.mockImplementation(async (client, _keys, fn) => {
      events.push('advisory');
      return fn(client);
    });
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (String(sql).includes('FROM users')) {
        events.push('users-share');
        return [liveDirectUser()];
      }
      if (String(sql).includes('FROM admins')) {
        events.push('admins-share');
        return [];
      }
      return [];
    });
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.slice(0, 3)).toEqual(['advisory', 'users-share', 'admins-share']);
  });

  it('takes delegated identity advisory locks before row share locks', async () => {
    const events = [];
    withAuthRevocationLocksMock.mockImplementation(async (client, _keys, fn) => {
      events.push('advisory');
      return fn(client);
    });
    queryRawUnsafeMock.mockImplementation(async () => {
      events.push('dependent-share');
      return [liveDependent()];
    });
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(events.slice(0, 2)).toEqual(['advisory', 'dependent-share']);
  });

  it('exposes no active socket or payload when registration commit rejects', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    transactionCommitError = new Error('commit rejected');
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(1013, 'Authentication unavailable');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
    const closeCalls = socket.close.mock.calls.length;
    sendToUser(DIRECT_USER_UID, 'clinical:update', { phi: 'must-not-deliver' });
    expect(socket.close).toHaveBeenCalledTimes(closeCalls);
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
  });

  it('registers a direct UUID socket before a jti-scoped revocation publishes', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    transactionCommitHook = () => {
      pushSessionRevoked(DIRECT_USER_UID, {
        reason: 'logout',
        jti: 'direct-uuid-access',
      });
    };
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('denies when revoke-all commits after the first check but before registration', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    isUserTokensRevokedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock).toHaveBeenCalledTimes(2);
    expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('keeps pending-auth sockets out of normal broadcast and user delivery', async () => {
    let finishFinalCheck;
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    isUserTokensRevokedMock
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFinalCheck = () => resolve(false);
      }));
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(finishFinalCheck).toEqual(expect.any(Function));
    broadcast('ward:clinical-update', { phi: 'must-not-deliver' });
    sendToUser(DIRECT_USER_UID, 'clinical:update', { phi: 'must-not-deliver' });
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));

    finishFinalCheck();
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('keeps pending registries structurally unreachable from the broadcast loop', () => {
    const source = readFileSync(
      new URL('../../utils/websocket/wsServer.js', import.meta.url),
      'utf8',
    );
    const broadcastLoop = source.slice(
      source.indexOf('function deliverBroadcastLocal'),
      source.indexOf('function deliverUserLocal'),
    );
    expect(broadcastLoop).toMatch(/for \(const \[ws, meta\] of socketMeta\)/);
    expect(broadcastLoop).not.toMatch(/pendingClients|pendingRevocationClients|pendingSocketMeta/);
  });

  it('lets a revoke-all push close a pending-auth socket before promotion', async () => {
    let finishFinalCheck;
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    isUserTokensRevokedMock
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFinalCheck = () => resolve(false);
      }));
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked(DIRECT_USER_UID, { reason: 'admin_deactivated' });
    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    finishFinalCheck();
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
    const closeCalls = socket.close.mock.calls.length;
    pushSessionRevoked(DIRECT_USER_UID, { reason: 'duplicate-push' });
    sendToUser(DIRECT_USER_UID, 'clinical:update', { phi: 'must-not-deliver' });
    expect(socket.close).toHaveBeenCalledTimes(closeCalls);
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
  });

  it('lets a jti-scoped push close the matching pending-auth socket', async () => {
    let finishFinalCheck;
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    isUserTokensRevokedMock
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFinalCheck = () => resolve(false);
      }));
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    pushSessionRevoked(DIRECT_USER_UID, {
      reason: 'logout',
      jti: 'direct-uuid-access',
    });
    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    finishFinalCheck();
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('denies when jti revocation commits after the first check but before registration', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    isTokenBlacklistedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isTokenBlacklistedMock).toHaveBeenCalledTimes(2);
    expect(socket.close).toHaveBeenCalledWith(4001, 'Token has been revoked');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('blocks post-promotion delivery from durable revoke-all state even when fanout is lost', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.send.mockClear();
    isUserTokensRevokedMock.mockResolvedValueOnce(true);

    sendToUser(DIRECT_USER_UID, 'clinical:update', { phi: 'must-not-deliver' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
    expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
  });

  it('blocks post-promotion delivery from durable jti state even when fanout is lost', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.send.mockClear();
    isTokenBlacklistedMock.mockResolvedValueOnce(true);

    sendToUser(DIRECT_USER_UID, 'clinical:update', { phi: 'must-not-deliver' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
    expect(socket.close).toHaveBeenCalledWith(4001, 'Token has been revoked');
  });

  it('blocks post-promotion delegated delivery after a lost tuple-revocation fanout', async () => {
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.emit('connection', socket, {
      url: '/ws?token=delegated-ticket', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    socket.send.mockClear();
    isDelegatedTupleRevokedMock.mockResolvedValueOnce(true);

    sendToUser('dependent-1', 'clinical:update', { phi: 'must-not-deliver' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
    expect(socket.close).toHaveBeenCalledWith(4001, 'Delegated session revoked');
  });

  it('closes a remotely revoked socket within the durable sweep bound when PubSub is lost', async () => {
    let patrol;
    const intervalHandle = { unref: jest.fn() };
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((callback, delay) => {
      patrol = callback;
      expect(delay).toBe(WS_REMOTE_REVOCATION_CLOSE_BOUND_MS);
      return intervalHandle;
    });
    try {
      queryRawUnsafeMock
        .mockResolvedValueOnce([liveDirectUser()])
        .mockResolvedValueOnce([]);
      initWebSocket({});
      const socket = new FakeSocket();
      serverInstance.clients.add(socket);
      serverInstance.emit('connection', socket, {
        url: '/ws?token=direct-uuid-access', headers: {},
      });
      await new Promise((resolve) => setImmediate(resolve));
      socket.send.mockClear();
      socket.isAlive = true;

      // The durable marker changed on another process and its PubSub message
      // was dropped. No local push is invoked in this process.
      isUserTokensRevokedMock.mockResolvedValue(true);
      patrol();
      await new Promise((resolve) => setImmediate(resolve));

      expect(WS_REMOTE_REVOCATION_CLOSE_BOUND_MS).toBe(30_000);
      expect(socket.send).not.toHaveBeenCalled();
      expect(socket.close).toHaveBeenCalledWith(4001, 'All sessions revoked');
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('reserves connection-limit slots synchronously across concurrent handshakes', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => (
      String(sql).includes('FROM admins') ? [] : [liveDirectUser()]
    ));
    initWebSocket({});
    const sockets = Array.from({ length: 6 }, () => new FakeSocket());
    for (const socket of sockets) {
      serverInstance.clients.add(socket);
      serverInstance.emit('connection', socket, {
        url: '/ws?token=direct-uuid-access', headers: {},
      });
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(sockets.filter((socket) => (
      socket.close.mock.calls.some(([code]) => code === 4029)
    ))).toHaveLength(1);
  });

  it('fails closed when the jti revocation store is unavailable', async () => {
    isTokenBlacklistedMock.mockRejectedValueOnce(new Error('revocation DB unavailable'));
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(1013, 'Authentication unavailable');
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('fails closed when the final under-lock jti check becomes unavailable', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    isTokenBlacklistedMock
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('revocation DB unavailable'));
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isTokenBlacklistedMock).toHaveBeenCalledTimes(2);
    expect(socket.close).toHaveBeenCalledWith(1013, 'Authentication unavailable');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
    const closeCalls = socket.close.mock.calls.length;
    pushSessionRevoked(DIRECT_USER_UID, { reason: 'after-failure' });
    sendToUser(DIRECT_USER_UID, 'clinical:update', { phi: 'must-not-deliver' });
    expect(socket.close).toHaveBeenCalledTimes(closeCalls);
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('must-not-deliver'));
  });

  it('indexes Hasura/provider sessions by app UUID so revoke-all closes sibling sockets', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    const siblingSocket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.clients.add(siblingSocket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=hasura-provider-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    serverInstance.emit('connection', siblingSocket, {
      url: '/ws?token=hasura-provider-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(DIRECT_USER_UID, 1000, 3);
    expect(socket.close).not.toHaveBeenCalledWith(4001, 'Identity unavailable');
    expect(siblingSocket.close).not.toHaveBeenCalledWith(4001, 'Identity unavailable');
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('connected'));
    expect(siblingSocket.send).toHaveBeenCalledWith(expect.stringContaining('connected'));

    pushSessionRevoked(DIRECT_USER_UID, { reason: 'logout' });

    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
    expect(siblingSocket.close).toHaveBeenCalledWith(4001, 'Session revoked');
  });

  it('fails closed before registration when two strong app identity aliases disagree', async () => {
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=conflicting-app-identity-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Invalid token payload');
    expect(isUserTokensRevokedMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('normalizes uppercase UUID claims for connection caps, delivery, and revocation', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);
    serverInstance.emit('connection', socket, {
      url: '/ws?token=uppercase-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(DIRECT_USER_UID);
    sendToUser(DIRECT_USER_UID.toUpperCase(), 'clinical:update', { value: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('clinical:update'));

    pushSessionRevoked(DIRECT_USER_UID.toUpperCase(), { reason: 'deactivated' });
    expect(socket.close).toHaveBeenCalledWith(4001, 'Session revoked');
  });

  it.each(['snake-provider-access', 'camel-provider-access'])(
    'uses the app UUID alias in %s instead of a generic provider subject',
    async (token) => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: `/ws?token=${token}`, headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(isUserTokensRevokedMock).toHaveBeenCalledWith(DIRECT_USER_UID, 1000, 3);
    expect(queryRawUnsafeMock.mock.calls[0][1]).toBe(DIRECT_USER_UID);
    expect(socket.close).not.toHaveBeenCalledWith(4001, 'Identity unavailable');
    },
  );

  it('keeps dynamic Prisma setup inside the fail-closed delivery boundary', () => {
    const source = readFileSync(
      new URL('../../utils/websocket/wsServer.js', import.meta.url),
      'utf8',
    );
    const barrier = source.slice(
      source.indexOf('async function deliverWithDurableRevocationBarrier'),
      source.indexOf('function queueRevocationGuardedDelivery'),
    );
    expect(barrier).toMatch(/try\s*{[\s\S]*await import\('\.\.\/\.\.\/lib\/prisma\.js'\)/);
  });

  it('accepts a live platform admin UUID under the same locked identity gate', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([liveDirectAdmin()]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('rejects an inactive admin UUID under the locked identity gate', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([liveDirectAdmin({ is_active: false, status: 'inactive' })]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Identity unavailable');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('rejects a UUID that exists in both identity realms', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser()])
      .mockResolvedValueOnce([liveDirectAdmin()]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Identity unavailable');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it.each([
    ['wrong tenant', { tenant_id: '33333333-3333-4333-8333-333333333333' }],
    ['deleted', { is_deleted: true, deleted_at: new Date().toISOString() }],
    ['merged', { merged_into_uid: '44444444-4444-4444-8444-444444444444' }],
  ])('rejects a direct UUID user that is %s', async (_label, lifecycle) => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([liveDirectUser(lifecycle)])
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access', headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Identity unavailable');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it('rejects a direct UUID socket when deactivation commits before identity locking', async () => {
    let finishBlockedLookup;
    queryRawUnsafeMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishBlockedLookup = () => resolve([liveDirectUser({
          is_active: false,
          status: 'inactive',
        })]);
      }))
      .mockResolvedValueOnce([]);
    initWebSocket({});
    const socket = new FakeSocket();
    serverInstance.clients.add(socket);

    serverInstance.emit('connection', socket, {
      url: '/ws?token=direct-uuid-access',
      headers: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(finishBlockedLookup).toEqual(expect.any(Function));
    expect(socket.close).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));

    finishBlockedLookup();
    await new Promise((resolve) => setImmediate(resolve));

    expect(socket.close).toHaveBeenCalledWith(4001, 'Identity unavailable');
    expect(socket.send).not.toHaveBeenCalledWith(expect.stringContaining('connected'));
  });

  it.each([
    ['inactive', { is_active: false }],
    ['deleted', { is_deleted: true, deleted_at: new Date().toISOString(), status: 'deleted' }],
    ['merged', { merged_into_uid: 'survivor-1' }],
    // Stale flag: is_minor TRUE but the check-time DOB recompute says adult —
    // delegation ends at 18 even for already-minted tickets.
    ['an adult now', { is_minor_now: false }],
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

  it('rechecks a direct non-UUID socket after registration', async () => {
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
      ['user-1', 1000, 3, { client: expect.any(Object) }],
      ['user-1', 1000, 3, { client: expect.any(Object) }],
    ]);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('fails a delegated handshake closed when either durable lookup is unavailable', async () => {
    isSubjectDelegationRevokedMock.mockRejectedValue(new Error('durable store down'));
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
    expect(isSubjectDelegationRevokedMock).toHaveBeenCalledWith('dependent-1', 1000);
    expect(socket.close).toHaveBeenCalledWith(1013, 'Authentication unavailable');
  });
});
