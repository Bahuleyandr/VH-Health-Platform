import { jest } from '@jest/globals';

import {
  claimLabResultIngestCommand,
  completeLabResultIngestCommand,
  finaliseHttpIdempotencyInTx,
} from '../../services/lab/labResultIngestCommandService.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '10000000-0000-4000-8000-000000000001';
const COMMAND_KEY = 'manual-result:order-123';
const REQUEST_BODY_SHA256 = 'a'.repeat(64);

function makeTx(...results) {
  return {
    $queryRawUnsafe: jest.fn(),
    results,
  };
}

function queueResults(tx) {
  for (const result of tx.results) {
    tx.$queryRawUnsafe.mockResolvedValueOnce(result);
  }
  delete tx.results;
  return tx;
}

function normalizedSql(tx, callIndex = 0) {
  return tx.$queryRawUnsafe.mock.calls[callIndex][0].replace(/\s+/g, ' ').trim();
}

function validClaim(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    actorUid: ACTOR_UID,
    scope: 'manual_result',
    commandKey: COMMAND_KEY,
    requestBodySha256: REQUEST_BODY_SHA256,
    ...overrides,
  };
}

describe('labResultIngestCommandService', () => {
  describe('claimLabResultIngestCommand', () => {
    test('requires a transaction client before attempting a claim', async () => {
      await expect(claimLabResultIngestCommand(validClaim({ tx: null })))
        .rejects.toThrow('Lab result command claim requires a transaction client');
    });

    test.each([
      ['missing actor', { actorUid: null }],
      ['empty actor', { actorUid: '' }],
      ['malformed actor UUID', { actorUid: 'lab-tech-1' }],
      ['missing tenant', { tenantId: null }],
      ['malformed tenant UUID', { tenantId: 'tenant-1' }],
      ['unsupported scope', { scope: 'oru_result' }],
      ['missing scope', { scope: undefined }],
      ['nonnumeric command key', { commandKey: 123 }],
      ['empty command key', { commandKey: '' }],
      ['leading command-key whitespace', { commandKey: ` ${COMMAND_KEY}` }],
      ['trailing command-key whitespace', { commandKey: `${COMMAND_KEY} ` }],
      ['command key over 200 characters', { commandKey: 'k'.repeat(201) }],
      ['missing request fingerprint', { requestBodySha256: undefined }],
      ['short request fingerprint', { requestBodySha256: 'a'.repeat(63) }],
      ['uppercase request fingerprint', { requestBodySha256: 'A'.repeat(64) }],
      ['nonhex request fingerprint', { requestBodySha256: 'g'.repeat(64) }],
      ['whitespace-padded fingerprint', { requestBodySha256: ` ${REQUEST_BODY_SHA256}` }],
    ])('rejects invalid identity: %s', async (_label, overrides) => {
      const tx = makeTx();

      await expect(claimLabResultIngestCommand({ tx, ...validClaim(overrides) }))
        .rejects.toMatchObject({
          statusCode: 400,
          code: 'LAB_RESULT_COMMAND_INVALID',
        });
      expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    test.each(['manual_result', 'panel_result'])(
      'atomically creates the first %s claim with the complete identity',
      async (scope) => {
        const inserted = {
          id: 901n,
          status: 'processing',
          request_body_sha256: REQUEST_BODY_SHA256,
          result_ids: [],
          panel_id: null,
          response_data: null,
        };
        const tx = queueResults(makeTx([inserted]));

        const claimed = await claimLabResultIngestCommand({
          tx,
          ...validClaim({ scope, commandKey: 'k'.repeat(200) }),
        });

        expect(claimed).toEqual({ replayed: false, command: inserted });
        expect(claimed.command).toBe(inserted);
        expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
        expect(normalizedSql(tx)).toContain('INSERT INTO lab_result_ingest_commands');
        expect(normalizedSql(tx)).toContain(
          'ON CONFLICT (tenant_id, actor_uid, command_scope, command_key) DO NOTHING',
        );
        expect(normalizedSql(tx)).toContain(
          'RETURNING id, status, request_body_sha256, result_ids, panel_id, response_data',
        );
        expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
          expect.any(String),
          TENANT_ID,
          ACTOR_UID,
          scope,
          'k'.repeat(200),
          REQUEST_BODY_SHA256,
        );
      },
    );

    test('returns the exact completed command under a locked replay lookup', async () => {
      const responseData = {
        result: { id: 73, status: 'preliminary' },
        critical_alert: null,
      };
      const existing = {
        id: 902n,
        status: 'completed',
        request_body_sha256: REQUEST_BODY_SHA256,
        result_ids: [73],
        panel_id: null,
        response_data: responseData,
      };
      const tx = queueResults(makeTx([], [existing]));

      const claimed = await claimLabResultIngestCommand({ tx, ...validClaim() });

      expect(claimed).toEqual({ replayed: true, command: existing });
      expect(claimed.command).toBe(existing);
      expect(claimed.command.response_data).toBe(responseData);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
      expect(normalizedSql(tx, 1)).toContain('FROM lab_result_ingest_commands');
      expect(normalizedSql(tx, 1)).toContain('WHERE tenant_id = $1::uuid');
      expect(normalizedSql(tx, 1)).toContain('AND actor_uid = $2::uuid');
      expect(normalizedSql(tx, 1)).toContain('AND command_scope = $3');
      expect(normalizedSql(tx, 1)).toContain('AND command_key = $4');
      expect(normalizedSql(tx, 1)).toContain('FOR UPDATE');
      expect(tx.$queryRawUnsafe.mock.calls[1]).toEqual([
        expect.any(String),
        TENANT_ID,
        ACTOR_UID,
        'manual_result',
        COMMAND_KEY,
      ]);
    });

    test('rejects reuse of a command key with a different request body', async () => {
      const tx = queueResults(makeTx([], [{
        id: 903n,
        status: 'completed',
        request_body_sha256: 'b'.repeat(64),
        response_data: { result: { id: 73 } },
      }]));

      await expect(claimLabResultIngestCommand({ tx, ...validClaim() }))
        .rejects.toMatchObject({
          statusCode: 422,
          code: 'LAB_RESULT_COMMAND_BODY_MISMATCH',
          message: 'Idempotency-Key reused with a different request body',
        });
    });

    test('fails closed if a lost conflict row cannot be locked', async () => {
      const tx = queueResults(makeTx([], []));

      await expect(claimLabResultIngestCommand({ tx, ...validClaim() }))
        .rejects.toMatchObject({
          statusCode: 409,
          code: 'LAB_RESULT_COMMAND_CONCURRENT_CHANGE',
        });
    });

    test.each([
      ['processing command', { status: 'processing', response_data: null }],
      ['completed command without a response', { status: 'completed', response_data: null }],
      ['unexpected status with a response', { status: 'failed', response_data: {} }],
    ])('rejects an in-flight or incomplete replay: %s', async (_label, state) => {
      const tx = queueResults(makeTx([], [{
        id: 904n,
        request_body_sha256: REQUEST_BODY_SHA256,
        ...state,
      }]));

      await expect(claimLabResultIngestCommand({ tx, ...validClaim() }))
        .rejects.toMatchObject({
          statusCode: 409,
          code: 'LAB_RESULT_COMMAND_IN_FLIGHT',
        });
    });
  });

  describe('completeLabResultIngestCommand', () => {
    test('requires a transaction client before attempting completion', async () => {
      await expect(completeLabResultIngestCommand({
        tx: null,
        tenantId: TENANT_ID,
        commandId: 901n,
        resultIds: [1],
        responseData: { result: { id: 1 } },
      })).rejects.toThrow('Lab result command completion requires a transaction client');
    });

    test('completes only a processing command with the exact result set and panel identity', async () => {
      const responseData = {
        panel: { id: '20000000-0000-4000-8000-000000000001' },
        results: [{ id: 41 }, { id: 42 }, { id: 43 }],
      };
      const completed = {
        id: 905n,
        status: 'completed',
        result_ids: [41, 42, 43],
        panel_id: '20000000-0000-4000-8000-000000000001',
        response_data: responseData,
      };
      const tx = queueResults(makeTx([completed]));
      const resultIds = ['41', 42, 43n];

      const result = await completeLabResultIngestCommand({
        tx,
        tenantId: TENANT_ID,
        commandId: 905n,
        resultIds,
        panelId: '20000000-0000-4000-8000-000000000001',
        responseData,
      });

      expect(result).toBe(completed);
      expect(resultIds).toEqual(['41', 42, 43n]);
      expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(normalizedSql(tx)).toContain("SET status = 'completed'");
      expect(normalizedSql(tx)).toContain('result_ids = $3::int[]');
      expect(normalizedSql(tx)).toContain('panel_id = $4::uuid');
      expect(normalizedSql(tx)).toContain('response_data = $5::jsonb');
      expect(normalizedSql(tx)).toContain("AND status = 'processing'");
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        TENANT_ID,
        905n,
        [41, 42, 43],
        '20000000-0000-4000-8000-000000000001',
        JSON.stringify(responseData),
      );
    });

    test('uses a null panel identity for a single manual result command', async () => {
      const tx = queueResults(makeTx([{
        id: 906n,
        status: 'completed',
        result_ids: [91],
        panel_id: null,
        response_data: { result: { id: 91 } },
      }]));
      const responseData = { result: { id: 91 } };

      await completeLabResultIngestCommand({
        tx,
        tenantId: TENANT_ID,
        commandId: 906n,
        resultIds: [91],
        responseData,
      });

      expect(tx.$queryRawUnsafe.mock.calls[0][4]).toBeNull();
      expect(tx.$queryRawUnsafe.mock.calls[0][5]).toBe(JSON.stringify(responseData));
    });

    test('fails closed when the processing command cannot be updated', async () => {
      const tx = queueResults(makeTx([]));

      await expect(completeLabResultIngestCommand({
        tx,
        tenantId: TENANT_ID,
        commandId: 907n,
        resultIds: [92],
        responseData: { result: { id: 92 } },
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'LAB_RESULT_COMMAND_CONCURRENT_CHANGE',
      });
    });
  });

  describe('finaliseHttpIdempotencyInTx', () => {
    test('requires a transaction client before inspecting the optional claim', async () => {
      await expect(finaliseHttpIdempotencyInTx({
        tx: null,
        claimId: null,
        responseData: { result: { id: 1 } },
      })).rejects.toThrow('HTTP idempotency finalization requires a transaction client');
    });

    test.each([undefined, null, '', 0])(
      'is a no-op when there is no HTTP claim (%p)',
      async (claimId) => {
        const tx = makeTx();

        await expect(finaliseHttpIdempotencyInTx({
          tx,
          claimId,
          responseData: { result: { id: 1 } },
        })).resolves.toBeNull();
        expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
      },
    );

    test('persists the exact success envelope, including request correlation', async () => {
      const tx = queueResults(makeTx([{ id: 501 }]));
      const responseData = { result: { id: 93, status: 'preliminary' } };

      const result = await finaliseHttpIdempotencyInTx({
        tx,
        claimId: 501,
        responseData,
        requestId: 'req-lab-123',
      });

      expect(result).toEqual({ id: 501 });
      expect(normalizedSql(tx)).toContain("SET status = 'complete'");
      expect(normalizedSql(tx)).toContain('response_status = 200');
      expect(normalizedSql(tx)).toContain('response_body = $2::jsonb');
      expect(normalizedSql(tx)).toContain("AND status = 'in_flight'");
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        expect.any(String),
        501,
        JSON.stringify({
          success: true,
          message: 'Success',
          data: responseData,
          requestId: 'req-lab-123',
        }),
      );
    });

    test('omits requestId from the replay envelope when none was supplied', async () => {
      const tx = queueResults(makeTx([{ id: 502 }]));
      const responseData = { results: [{ id: 94 }] };

      await finaliseHttpIdempotencyInTx({ tx, claimId: 502, responseData });

      expect(JSON.parse(tx.$queryRawUnsafe.mock.calls[0][2])).toEqual({
        success: true,
        message: 'Success',
        data: responseData,
      });
    });

    test('fails closed when the in-flight HTTP claim cannot be finalized', async () => {
      const tx = queueResults(makeTx([]));

      await expect(finaliseHttpIdempotencyInTx({
        tx,
        claimId: 503,
        responseData: { result: { id: 95 } },
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'LAB_RESULT_HTTP_IDEMPOTENCY_CHANGED',
      });
    });
  });
});
