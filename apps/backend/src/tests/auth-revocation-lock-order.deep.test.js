import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import WebSocket from 'ws';

import { generateToken } from '../utils/jwtUtils.js';
import {
  authRevocationLockKeys,
  getCurrentTokenEpoch,
  persistRevokeAllUserTokens,
  persistRevokeDelegatedTuple,
  withAuthIdentityLifecycleLocks,
  withAuthRevocationLocks,
} from '../utils/tokenBlacklist.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function txClient(client) {
  return {
    async $queryRawUnsafe(statement, ...params) {
      return (await client.query(statement, params)).rows;
    },
  };
}

describeIfDb('auth identity advisory lock ordering', () => {
  let registration;
  let lifecycleWriter;
  let userUid;
  let guardianUid;
  let guardianId;
  let dependentUid;
  let wsUserUid;

  beforeAll(async () => {
    registration = new Client({ connectionString: databaseUrl });
    lifecycleWriter = new Client({ connectionString: databaseUrl });
    await Promise.all([registration.connect(), lifecycleWriter.connect()]);
    userUid = randomUUID();
    guardianUid = randomUUID();
    dependentUid = randomUUID();
    wsUserUid = randomUUID();
    await registration.query("SELECT set_config('app.current_tenant_id', 'bypass', false)");
    await registration.query(
      `INSERT INTO users
         (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
       VALUES ($1::uuid, $2::uuid, 'Auth lock-order fixture', 'PATIENT',
               TRUE, 'active', FALSE, NOW())`,
      [userUid, TENANT_ID],
    );
    const guardian = await registration.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, is_deleted,
          is_minor, updated_at)
       VALUES ($1::uuid, $2::uuid, '+919899062001', 'Auth guardian fixture',
               'PATIENT', TRUE, 'active', FALSE, FALSE, NOW())
       RETURNING id`,
      [guardianUid, TENANT_ID],
    );
    guardianId = guardian.rows[0].id;
    await registration.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, is_deleted,
          is_minor, guardian_user_id, updated_at)
       VALUES ($1::uuid, $2::uuid, '+919899062002', 'Auth dependent fixture',
               'PATIENT', TRUE, 'active', FALSE, TRUE, $3, NOW())`,
      [dependentUid, TENANT_ID, guardianId],
    );
    await registration.query(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, is_active, status, is_deleted,
          updated_at)
       VALUES ($1::uuid, $2::uuid, '+919899062003', 'Auth WebSocket fixture',
               'PATIENT', TRUE, 'active', FALSE, NOW())`,
      [wsUserUid, TENANT_ID],
    );
  });

  afterAll(async () => {
    if (!registration || !lifecycleWriter) return;
    await registration.query('ROLLBACK').catch(() => {});
    await lifecycleWriter.query('ROLLBACK').catch(() => {});
    await registration.query("SELECT set_config('app.current_tenant_id', 'bypass', false)").catch(() => {});
    await registration.query(
      `DELETE FROM invalidated_tokens
        WHERE jti = ANY($1::text[])`,
      [[
        `user:${wsUserUid}`,
        `user:delegated:${guardianUid.toLowerCase()}:${dependentUid.toLowerCase()}`,
      ]],
    ).catch(() => {});
    await registration.query(
      'UPDATE users SET guardian_user_id = NULL WHERE uid = $1::uuid',
      [dependentUid],
    ).catch(() => {});
    await registration.query(
      'DELETE FROM users WHERE uid = ANY($1::uuid[])',
      [[userUid, guardianUid, dependentUid, wsUserUid]],
    ).catch(() => {});
    await Promise.all([registration.end(), lifecycleWriter.end()]);
  });

  test('registration and lifecycle mutation serialize advisory-first without a row-lock cycle', async () => {
    await registration.query('BEGIN');
    await registration.query("SET LOCAL app.current_tenant_id = 'bypass'");
    await registration.query("SET LOCAL lock_timeout = '5s'");
    await registration.query("SET LOCAL statement_timeout = '10s'");
    await withAuthIdentityLifecycleLocks(txClient(registration), [userUid], async () => {
      await registration.query('SELECT uid FROM users WHERE uid = $1::uuid FOR SHARE', [userUid]);
    });

    const registrationPid = (await registration.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writerPid = (await lifecycleWriter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writer = (async () => {
      await lifecycleWriter.query('BEGIN');
      await lifecycleWriter.query("SET LOCAL app.current_tenant_id = 'bypass'");
      await lifecycleWriter.query("SET LOCAL lock_timeout = '5s'");
      await lifecycleWriter.query("SET LOCAL statement_timeout = '10s'");
      await withAuthIdentityLifecycleLocks(txClient(lifecycleWriter), [userUid], async () => {
        await lifecycleWriter.query(
          `UPDATE users SET status = 'inactive', is_active = FALSE, updated_at = NOW()
            WHERE uid = $1::uuid`,
          [userUid],
        );
      });
      await lifecycleWriter.query('COMMIT');
    })();

    let blockedByRegistration = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blockers = await registration.query(
        'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
        [registrationPid, writerPid],
      );
      if (blockers.rows[0].blocked) {
        blockedByRegistration = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blockedByRegistration).toBe(true);

    await registration.query('COMMIT');
    await expect(writer).resolves.toBeUndefined();
    const updated = await registration.query(
      'SELECT status, is_active FROM users WHERE uid = $1::uuid',
      [userUid],
    );
    expect(updated.rows).toEqual([{ status: 'inactive', is_active: false }]);
  }, 20_000);

  test('delegated registration and unlink serialize identity then tuple locks without a cycle', async () => {
    const tupleIdentity = `delegated:${guardianUid.toLowerCase()}:${dependentUid.toLowerCase()}`;
    const registrationKeys = authRevocationLockKeys({
      identityUids: [guardianUid, dependentUid],
      tupleKeys: [tupleIdentity],
    });

    await registration.query('BEGIN');
    await registration.query("SET LOCAL app.current_tenant_id = 'bypass'");
    await registration.query("SET LOCAL lock_timeout = '5s'");
    await registration.query("SET LOCAL statement_timeout = '10s'");
    await withAuthRevocationLocks(txClient(registration), registrationKeys, async () => {
      await registration.query(
        `SELECT dependent.uid
           FROM users AS dependent
           JOIN users AS guardian ON guardian.id = dependent.guardian_user_id
          WHERE dependent.uid = $1::uuid
            AND guardian.uid = $2::uuid
          FOR SHARE OF dependent, guardian`,
        [dependentUid, guardianUid],
      );
    });

    const registrationPid = (await registration.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writerPid = (await lifecycleWriter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writer = (async () => {
      await lifecycleWriter.query('BEGIN');
      await lifecycleWriter.query("SET LOCAL app.current_tenant_id = 'bypass'");
      await lifecycleWriter.query("SET LOCAL lock_timeout = '5s'");
      await lifecycleWriter.query("SET LOCAL statement_timeout = '10s'");
      await withAuthIdentityLifecycleLocks(
        txClient(lifecycleWriter),
        [guardianUid, dependentUid],
        async () => {
          await persistRevokeDelegatedTuple(guardianUid, dependentUid, {
            client: txClient(lifecycleWriter),
            reason: 'lock_order_test',
          });
          await lifecycleWriter.query(
            `UPDATE users
                SET guardian_user_id = NULL, updated_at = NOW()
              WHERE uid = $1::uuid
                AND guardian_user_id = $2`,
            [dependentUid, guardianId],
          );
        },
      );
      await lifecycleWriter.query('COMMIT');
    })();

    let blockedByRegistration = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blockers = await registration.query(
        'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
        [registrationPid, writerPid],
      );
      if (blockers.rows[0].blocked) {
        blockedByRegistration = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blockedByRegistration).toBe(true);

    await registration.query('COMMIT');
    await expect(writer).resolves.toBeUndefined();
    const state = await registration.query(
      `SELECT guardian_user_id,
              EXISTS (
                SELECT 1 FROM invalidated_tokens
                 WHERE jti = $2 AND expires_at > NOW()
              ) AS tuple_revoked
         FROM users
        WHERE uid = $1::uuid`,
      [dependentUid, `user:${tupleIdentity}`],
    );
    expect(state.rows).toEqual([{ guardian_user_id: null, tuple_revoked: true }]);
  }, 20_000);

  test('a real remote WebSocket closes by the durable sweep when PubSub is lost', async () => {
    const processId = randomUUID();
    const procA = await import(`../utils/websocket/wsServer.js?lost-pubsub-writer=${processId}`);
    const procB = await import(`../utils/websocket/wsServer.js?lost-pubsub-socket=${processId}`);
    const server = http.createServer();
    procB.initWebSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const epoch = await getCurrentTokenEpoch(wsUserUid);
    const token = generateToken({
      uid: wsUserUid,
      role: 'PATIENT',
      tenant_id: TENANT_ID,
      tenantId: TENANT_ID,
      token_epoch: epoch,
      jti: randomUUID(),
    }, '1h');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const frames = [];

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for connected')), 5_000);
        socket.on('message', (raw) => {
          const frame = JSON.parse(raw.toString());
          frames.push(frame);
          if (frame.event === 'connected') {
            clearTimeout(timer);
            resolve();
          }
        });
        socket.once('error', reject);
      });

      const closePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('remote revoked socket exceeded durable close bound')),
          procB.WS_REMOTE_REVOCATION_CLOSE_BOUND_MS + 5_000,
        );
        socket.once('close', (code, reason) => {
          clearTimeout(timer);
          resolve({ code, reason: reason.toString() });
        });
      });

      const revokedAt = await persistRevokeAllUserTokens(wsUserUid, {
        requireEvidence: true,
        reason: 'lost_pubsub_deep_test',
      });
      // Process A has no socket and no fanout subscriber. Its best-effort push
      // is therefore intentionally lost to process B; only B's durable patrol
      // can observe the committed marker and close the real socket.
      procA.pushSessionRevoked(wsUserUid, { reason: 'lost_pubsub_deep_test' });
      procA.sendToUser(wsUserUid, 'clinical:update', { phi: 'must-not-deliver' });

      expect(Number.isFinite(revokedAt)).toBe(true);
      await expect(closePromise).resolves.toEqual({
        code: 4001,
        reason: 'All sessions revoked',
      });
      expect(frames.some((frame) => frame.event === 'clinical:update')).toBe(false);
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      await procB.closeWebSocket();
      await new Promise((resolve) => server.close(resolve));
    }
  }, 45_000);
});
