import { readFileSync } from 'node:fs';

const RECORDED_AT = '2026-07-30T12:00:00.000Z';
const PAYLOAD_OCCURRED_AT = '2026-07-29T08:30:00.000Z';
const EXPLICIT_OCCURRED_AT = '2026-07-28T07:15:00.000Z';

const projectorFiles = Object.freeze({
  diagnostic: '../services/pathways/diagnosticPathwayProjector.js',
  referral: '../services/pathways/referralPathwayProjector.js',
  op: '../services/pathways/opPathwayProjector.js',
  inpatient: '../services/pathways/inpatientPathwayProjector.js',
  emergency: '../services/pathways/emergencyPathwayProjector.js',
});

function baselineEffectiveOccurrence(fixture) {
  if (
    fixture.eventType === 'admission.diagnostic_resource_linked'
    && !Number.isNaN(new Date(fixture.payload?.occurred_at).getTime())
  ) {
    return new Date(fixture.payload.occurred_at).toISOString();
  }
  return new Date(fixture.createdAt).toISOString();
}

function migratedOccurrence(fixture) {
  if (fixture.provenance === 'explicit') {
    return new Date(fixture.occurredAt).toISOString();
  }
  return baselineEffectiveOccurrence(fixture);
}

function normalizedProjection(fixture, occurredAt) {
  return {
    projector: fixture.projector,
    outcome: fixture.outcome,
    transitionIdentity: `${fixture.projector}:${fixture.aggregateId}:${fixture.eventId}`,
    taskLink: `task:${fixture.aggregateId}`,
    slaLink: `sla:${fixture.aggregateId}`,
    resourceReference: `${fixture.resourceType}:${fixture.resourceId}`,
    occurrence: {
      transitionOccurredAt: occurredAt,
      taskObservedAt: occurredAt,
      slaObservedAt: occurredAt,
      resourceOccurredAt: occurredAt,
    },
  };
}

const legacyFixtures = Object.freeze([
  {
    projector: 'diagnostic',
    eventType: 'diagnostic.report_released',
    eventId: '1001',
    aggregateId: 'diag-1',
    resourceType: 'diagnostic_result_generation',
    resourceId: 'diag-generation-1',
    outcome: 'handled',
    createdAt: RECORDED_AT,
    payload: { occurred_at: PAYLOAD_OCCURRED_AT },
    provenance: 'legacy_recorded_at',
  },
  {
    projector: 'referral',
    eventType: 'referral.created',
    eventId: '1002',
    aggregateId: 'referral-1',
    resourceType: 'referral',
    resourceId: 'referral-1',
    outcome: 'handled',
    createdAt: RECORDED_AT,
    payload: {},
    provenance: 'legacy_recorded_at',
  },
  {
    projector: 'op',
    eventType: 'appointment.completed',
    eventId: '1003',
    aggregateId: 'appointment-1',
    resourceType: 'appointment',
    resourceId: 'appointment-1',
    outcome: 'handled',
    createdAt: RECORDED_AT,
    payload: {},
    provenance: 'legacy_recorded_at',
  },
  {
    projector: 'inpatient',
    eventType: 'admission.created',
    eventId: '1004',
    aggregateId: 'admission-1',
    resourceType: 'admission',
    resourceId: 'admission-1',
    outcome: 'handled',
    createdAt: RECORDED_AT,
    payload: {},
    provenance: 'legacy_recorded_at',
  },
  {
    projector: 'emergency',
    eventType: 'emergency.visit.created',
    eventId: '1005',
    aggregateId: 'emergency-1',
    resourceType: 'emergency_visit',
    resourceId: 'emergency-1',
    outcome: 'handled',
    createdAt: RECORDED_AT,
    payload: {},
    provenance: 'legacy_recorded_at',
  },
  {
    projector: 'inpatient',
    eventType: 'admission.diagnostic_resource_linked',
    eventId: '1006',
    aggregateId: 'admission-1',
    resourceType: 'diagnostic_result_generation',
    resourceId: 'diag-generation-2',
    outcome: 'handled',
    createdAt: RECORDED_AT,
    payload: { occurred_at: PAYLOAD_OCCURRED_AT },
    provenance: 'legacy_payload',
  },
]);

describe('five-projector occurrence normalization parity', () => {
  it.each(legacyFixtures)(
    'keeps the $projector/$eventType baseline projection byte-identical',
    (fixture) => {
      const before = normalizedProjection(
        fixture,
        baselineEffectiveOccurrence(fixture),
      );
      const after = normalizedProjection(fixture, migratedOccurrence(fixture));
      expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    },
  );

  it('keeps a new explicit occurrence equal to recorded time identical', () => {
    const fixture = {
      ...legacyFixtures[0],
      eventId: '2001',
      provenance: 'explicit',
      occurredAt: RECORDED_AT,
    };
    expect(normalizedProjection(fixture, migratedOccurrence(fixture)))
      .toEqual(normalizedProjection(fixture, RECORDED_AT));
  });

  it('isolates a different explicit occurrence to occurrence-derived fields', () => {
    const fixture = {
      ...legacyFixtures[0],
      eventId: '2002',
      provenance: 'explicit',
      occurredAt: EXPLICIT_OCCURRED_AT,
    };
    const before = normalizedProjection(fixture, RECORDED_AT);
    const after = normalizedProjection(fixture, migratedOccurrence(fixture));
    const { occurrence: beforeOccurrence, ...beforeIdentity } = before;
    const { occurrence: afterOccurrence, ...afterIdentity } = after;

    expect(afterIdentity).toEqual(beforeIdentity);
    expect(afterOccurrence).not.toEqual(beforeOccurrence);
    expect(new Set(Object.values(afterOccurrence))).toEqual(
      new Set([EXPLICIT_OCCURRED_AT]),
    );
  });

  it('keeps historically ignored payload occurrence on recorded time', () => {
    const fixture = legacyFixtures[0];
    expect(fixture.payload.occurred_at).not.toBe(fixture.createdAt);
    expect(migratedOccurrence(fixture)).toBe(RECORDED_AT);
  });

  it.each(Object.entries(projectorFiles))(
    '%s consumes only the normalized event occurrence',
    (_projector, relativePath) => {
      const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
      expect(source).toMatch(/event\.occurred_at/);
      expect(source).not.toMatch(/event\.created_at/);
      if (_projector === 'inpatient') {
        expect(source).not.toMatch(/event\.payload\?\.occurred_at/);
      }
    },
  );

  it('passes persisted occurrence and recorded-time provenance through the seam', () => {
    const source = readFileSync(
      new URL('../services/events/pathwayProjectorService.js', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/e\.occurred_at/);
    expect(source).toMatch(/occurred_at: row\.occurred_at/);
    expect(source).toMatch(/recorded_at: row\.recorded_at/);
    expect(source).not.toMatch(/created_at: row\.created_at/);
  });

  it('pins the migration backfill to the one historical payload exception', () => {
    const migration = readFileSync(
      new URL('../migrations/603_external_interface_recovery.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toMatch(
      /event_type = 'admission\.diagnostic_resource_linked'[\s\S]*payload ->> 'occurred_at'/,
    );
    expect(migration).toMatch(/ELSE created_at/);
    expect(migration).toContain("'legacy_payload'");
    expect(migration).toContain("'legacy_recorded_at'");
    expect(migration).toContain("'explicit'");
  });
});
