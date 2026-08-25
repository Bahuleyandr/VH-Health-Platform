// Re-audit lane J (1) — outbound ADT^A02.
//
// Before this, SUPPORTED_TYPES was ['ADT^A01','ADT^A03','ORM^O01','ORU^R01']
// and the only automatic emitters were admission / discharge / signed results.
// An intra-hospital transfer (ward or bed move) emitted NOTHING, so every
// downstream feed saw a patient admitted to bed A and later discharged from
// bed B with no event in between — while the INBOUND side has accepted A02
// since hl7InboundClinicalCommandService shipped.
//
// This suite pins the three things that make the emission correct:
//   1. ADT^A02 is an accepted outbound type at all (SUPPORTED_TYPES).
//   2. The message carries BOTH locations — PV1-3 new, PV1-6 prior — because
//      that diff is the entire clinical content of a transfer.
//   3. The queue identity is the bed_transfers row, not the admission, so the
//      SECOND move of one admission still emits.
//
// Driven on the prisma mock surface, no live DB.

import { jest } from '@jest/globals';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHL7 } from '../../services/hl7/hl7Parser.js';
import {
  admissionToADT,
  dischargeToADT,
  transferToADT,
} from '../../services/hl7/hl7Transformer.js';

const queryRawUnsafeMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryRawUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: jest.fn((_tenantId, callback) => callback(prismaMock)),
}));

const warnMock = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: warnMock, error: jest.fn() },
}));

// createSubscription validates the endpoint against the SSRF guard, which
// resolves DNS. The guard's own behaviour is covered by hl7-ssrf-guard.test.js;
// here it must simply not reach the network.
jest.unstable_mockModule('../../utils/ssrfGuard.js', () => ({
  assertSafeFeedUrl: jest.fn(async () => undefined),
  safeFetch: jest.fn(),
}));

const {
  createSubscription,
  emitTransferAdt,
  queueFeedMessage,
  DEFAULT_FEED_MESSAGE_TYPES,
} = await import('../../services/hl7/hl7OutboundService.js');

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const patientRow = {
  uid: PATIENT,
  tenant_id: TENANT,
  name: 'Transfer Patient',
  phone: '+919990001111',
  gender: 'female',
  birthday: '1990-02-02',
  address: 'Ward Road',
};

const movedAdmission = {
  id: 4242,
  patient_uid: PATIENT,
  tenant_id: TENANT,
  ward: 'ICU',
  bed_number: 'ICU-03',
  admitting_doctor: 'Dr Rao',
  admitted_at: new Date('2026-08-20T06:00:00Z'),
};

/** loadPatient → one active subscription → one INSERT that created a row. */
function primeSuccessfulQueue() {
  queryRawUnsafeMock
    .mockResolvedValueOnce([patientRow]) // loadPatient
    .mockResolvedValueOnce([{ id: 7 }]) // active subscriptions for the type
    .mockResolvedValueOnce([{ id: 11 }]); // INSERT ... RETURNING id
}

/** The (sql, ...params) tuple of the INSERT into hl7_outbound_messages. */
function insertCall() {
  return queryRawUnsafeMock.mock.calls.find(
    (call) => String(call[0]).includes('INSERT INTO hl7_outbound_messages'),
  );
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  warnMock.mockReset();
});

describe('transferToADT — the message a bed move must produce', () => {
  it('is an ADT^A02 carrying the NEW location in PV1-3 and the PRIOR one in PV1-6', () => {
    const message = transferToADT(movedAdmission, patientRow, {
      priorWard: 'General Ward',
      priorBedNumber: 'GW-11',
    });

    const parsed = parseHL7(message);
    expect(parsed.msh.messageType).toBe('ADT^A02');

    const pv1 = message.split('\r').find((seg) => seg.startsWith('PV1|')).split('|');
    expect(pv1[2]).toBe('I');
    expect(pv1[3]).toBe('ICU^ICU-03');
    expect(pv1[6]).toBe('General Ward^GW-11');
  });

  it('escapes each location component separately so a ward name cannot forge the ^', () => {
    const message = transferToADT(
      { ...movedAdmission, ward: 'ICU^FAKE', bed_number: 'B|1' },
      patientRow,
      { priorWard: 'Ward~3', priorBedNumber: 'W3\\07' },
    );
    const pv1 = message.split('\r').find((seg) => seg.startsWith('PV1|')).split('|');
    // Exactly one structural ^ per location field; the injected ones are escaped.
    expect(pv1[3]).toBe('ICU\\S\\FAKE^B\\F\\1');
    expect(pv1[6]).toBe('Ward\\R\\3^W3\\E\\07');
  });

  it('leaves PV1-6 empty on A01 and A03 — prior location is an A02-only field', () => {
    for (const message of [
      admissionToADT(movedAdmission, patientRow),
      dischargeToADT(movedAdmission, patientRow),
    ]) {
      const pv1 = message.split('\r').find((seg) => seg.startsWith('PV1|')).split('|');
      expect(pv1[6]).toBe('');
    }
  });
});

describe('emitTransferAdt', () => {
  it('queues ADT^A02 keyed on the bed_transfers row, not the admission', async () => {
    primeSuccessfulQueue();

    const queued = await emitTransferAdt(movedAdmission, {
      transferId: 901,
      priorWard: 'General Ward',
      priorBedNumber: 'GW-11',
    });

    expect(queued).toBe(1);
    const call = insertCall();
    expect(call).toBeDefined();
    // (tid, subscriptionId, messageType, controlId, payload,
    //  sourceTable, sourceId, patientUid, sourceEventKey, payloadSha256)
    expect(call[3]).toBe('ADT^A02');
    expect(call[6]).toBe('bed_transfers');
    expect(call[7]).toBe('901');
    expect(call[9]).toBe('bed_transfers:901');
    expect(call[5]).toContain('ADT^A02');
    expect(call[5]).toContain('General Ward^GW-11');
  });

  it('gives each move of the same admission its own queue identity', async () => {
    primeSuccessfulQueue();
    await emitTransferAdt(movedAdmission, { transferId: 901 });
    const firstKey = insertCall()[9];

    queryRawUnsafeMock.mockReset();
    primeSuccessfulQueue();
    await emitTransferAdt(movedAdmission, { transferId: 902 });
    const secondKey = insertCall()[9];

    // Same admission, two moves — the dedupe key must differ, otherwise the
    // second emission collides on (tenant, subscription, key, type) and the
    // move is silently never announced.
    expect(firstKey).toBe('bed_transfers:901');
    expect(secondKey).toBe('bed_transfers:902');
  });

  it('falls back to the message-control key rather than reusing an admission key', async () => {
    primeSuccessfulQueue();
    await emitTransferAdt(movedAdmission, {});
    const call = insertCall();
    expect(call[6]).toBeNull();
    expect(call[7]).toBeNull();
    expect(call[9]).toBe(`message-control:${call[4]}`);
    expect(call[9]).not.toContain('admissions:');
  });

  it('never throws into the committed transfer — a queue failure returns 0', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([patientRow])
      .mockRejectedValueOnce(new Error('subscription lookup exploded'));

    await expect(emitTransferAdt(movedAdmission, { transferId: 901 })).resolves.toBe(0);
    expect(warnMock).toHaveBeenCalled();
  });

  it('returns 0 without touching the queue when the patient cannot be resolved', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(emitTransferAdt(movedAdmission, { transferId: 901 })).resolves.toBe(0);
    expect(insertCall()).toBeUndefined();

    queryRawUnsafeMock.mockReset();
    await expect(emitTransferAdt({ id: 1 }, { transferId: 901 })).resolves.toBe(0);
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('SUPPORTED_TYPES', () => {
  it('accepts ADT^A02 as an outbound feed message type', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ id: 12 }]);

    const created = await queueFeedMessage({
      messageType: 'ADT^A02',
      hl7Payload: 'MSH|^~\\&|VHHEALTH|VH_HOSPITALS||EXTERNAL|20260824010203||ADT^A02|CTRL-A02|P|2.5',
      sourceTable: 'bed_transfers',
      sourceId: '901',
      patientUid: PATIENT,
      tenantId: TENANT,
    });

    expect(created).toBe(1);
  });

  it('still rejects a type outside the set', async () => {
    await expect(queueFeedMessage({
      messageType: 'ADT^A08',
      hl7Payload: 'MSH|^~\\&|X||||20260824010203||ADT^A08|CTRL|P|2.5',
      tenantId: TENANT,
    })).rejects.toMatchObject({ code: 'HL7_FEED_BAD_TYPE' });
  });
});

// Emitting A02 is only half the story: queueFeedMessage fans out with
// `$type = ANY(message_types)`, so a subscription that does not LIST the type
// receives nothing. Until migration 731 neither default listed A02, which made
// the emitter above fan out to zero rows on every default-configured feed.
describe('the default subscription scope reaches the transfer event', () => {
  it('gives a subscription created without message_types all four auto-emitted types', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 5 }]); // INSERT ... RETURNING

    await createSubscription(
      { name: 'State HIE bridge', endpointUrl: 'https://hie.example.org/hl7' },
      { tenantId: TENANT },
    );

    const call = queryRawUnsafeMock.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO hl7_feed_subscriptions'),
    );
    expect(call).toBeDefined();
    // (tid, name, endpointUrl, authHeader, messageTypes, actorUid)
    expect(call[5]).toEqual(['ADT^A01', 'ADT^A02', 'ADT^A03', 'ORU^R01']);
    expect(call[5]).toContain('ADT^A02');
  });

  it('still honours an explicit list — a receiver that cannot take A02 opts out', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: 6 }]);

    await createSubscription(
      {
        name: 'Legacy LIS',
        endpointUrl: 'https://lis.example.org/hl7',
        messageTypes: ['ORU^R01'],
      },
      { tenantId: TENANT },
    );

    const call = queryRawUnsafeMock.mock.calls.find(
      (c) => String(c[0]).includes('INSERT INTO hl7_feed_subscriptions'),
    );
    expect(call[5]).toEqual(['ORU^R01']);
  });

  it('matches the column DEFAULT that migration 731 installed', () => {
    // Read the default from prisma/schema.prisma rather than from 731's text.
    // schema.prisma is regenerated by `prisma db pull` after every migration
    // and byte-compared against the migrated database by
    // scripts/check-schema-drift.mjs, so it is a projection of the LIVE DDL —
    // it keeps measuring this invariant if some later migration moves the
    // default again, which a regex over 731 could never do.
    const schema = fs.readFileSync(fileURLToPath(new URL(
      '../../../prisma/schema.prisma',
      import.meta.url,
    )), 'utf8');

    const model = schema.match(/^model hl7_feed_subscriptions \{$([\s\S]*?)^\}$/m);
    expect(model).not.toBeNull();
    const column = model[1].match(/^\s*message_types\s+String\[\]\s+@default\(\[(.*?)\]\)\s*$/m);
    expect(column).not.toBeNull();

    const columnDefault = column[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);

    // Same set, so a subscription behaves identically whether the row was
    // created through the API or by direct SQL.
    expect([...columnDefault].sort()).toEqual([...DEFAULT_FEED_MESSAGE_TYPES].sort());
    expect(columnDefault).toContain('ADT^A02');
  });
});

describe('the transfer commit calls the emitter', () => {
  it('wires emitTransferAdt into admissionService.transferPatient post-commit', () => {
    const source = fs.readFileSync(fileURLToPath(new URL(
      '../../services/emr/admissionService.js',
      import.meta.url,
    )), 'utf8');

    const transfer = source.slice(
      source.indexOf('async function transferPatient('),
      source.indexOf('async function getActiveAdmissions('),
    );
    expect(transfer).toContain('emitTransferAdt');
    // Best-effort only: the import + call must sit in their own try/catch,
    // OUTSIDE the scopedTx callback that owns the clinical write.
    const emitAt = transfer.indexOf('emitTransferAdt(phase1.updated');
    const commitAt = transfer.indexOf('const phase1 = await scopedTx(');
    const closeAt = transfer.indexOf('if (phase1.bedTurnover) {');
    expect(emitAt).toBeGreaterThan(commitAt);
    expect(emitAt).toBeGreaterThan(closeAt);
    expect(transfer.slice(emitAt - 400, emitAt)).toContain('try {');
  });
});
