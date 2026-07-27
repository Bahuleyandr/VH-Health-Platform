import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
  PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES,
  PATHWAY_PROJECTOR_GENERATION_2_EVENT_TYPES,
  PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES,
  PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES,
  PATHWAY_PROJECTOR_GENERATION_5_EVENT_TYPES,
  PATHWAY_PROJECTOR_GENERATION_6_EVENT_TYPES,
  createPathwayProjectorRegistry,
  isPathwayProjectorRegistry,
  pathwayProjectorRegistry,
  pathwayProjectorRegistryV1,
  pathwayProjectorRegistryV2,
  pathwayProjectorRegistryV3,
  pathwayProjectorRegistryV4,
  pathwayProjectorRegistryV5,
  pathwayProjectorRegistryV6,
} from '../../services/events/pathwayProjectorRegistry.js';
import {
  EMERGENCY_PATHWAY_EVENT_TYPES,
  EMERGENCY_PATHWAY_EVENT_TYPES_V1,
} from '../../services/pathways/emergencyPathwayProjector.js';

describe('pathwayProjectorRegistry', () => {
  const expectedTypes = [
    'clinical.handover.created',
    'clinical.handover.acknowledged',
    'clinical.prehospital_handover.created',
    'clinical.prehospital_handover.accepted',
    'clinical_document.discharge_summary.saved',
    'clinical_document.discharge_summary.signed',
  ];
  const syntheticObserver = async () => ({ observed: true });
  const syntheticRegistry = createPathwayProjectorRegistry({
    generation: 2002,
    entries: [['test.changed', syntheticObserver]],
  });

  it('preserves prior generations and exposes the exact generation-6 membership', () => {
    const diagnosticTypes = [
      'diagnostic.result.generation_signed',
      'diagnostic.result.release_became_eligible',
      'diagnostic.result.normal_auto_closed',
      'diagnostic.result.generation_corrected',
      'diagnostic.result.action_recorded',
      'diagnostic.result.reopened',
    ];
    expect(PATHWAY_PROJECTOR_CONSUMER_KEY).toBe('care_pathway_projector');
    const referralTypes = [
      'referral.requested',
      'referral.seen',
      'referral.accepted',
      'referral.declined',
      'referral.rerouted',
      'referral.response_signed',
      'referral.closed',
      'referral.appointment_linked',
    ];
    const opTypes = [
      'appointment.created',
      'appointment.confirmed',
      'appointment.checked_in',
      'appointment.in_progress',
      'appointment.completed',
      'appointment.cancelled',
      'appointment.no_show',
      'appointment.rescheduled',
      'appointment.admission_advised',
      'appointment.follow_up_recorded',
      'appointment.closure_evidence_recorded',
      'appointment.child_resource_linked',
    ];
    const inpatientTypes = [
      'admission.created',
      'admission.readmission_linked',
      'admission.diagnostic_resource_linked',
      'bed.assigned',
      'bed.transferred',
      'discharge.workflow_opened',
      'discharge.work_item_completed',
      'discharge.drugs_dispensed',
      'clinical_document.discharge_summary.signed',
      'discharge.pending_result_handoff_recorded',
      'discharge.pending_result_available',
      'discharge.pending_result_resolved',
      'discharge.completed',
      'post_discharge.contact_recorded',
    ];
    expect(PATHWAY_PROJECTOR_GENERATION).toBe(6);
    expect(PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES).toEqual(expectedTypes);
    expect(PATHWAY_PROJECTOR_GENERATION_2_EVENT_TYPES).toEqual([
      ...expectedTypes,
      ...diagnosticTypes,
    ]);
    expect(PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES).toEqual([
      ...expectedTypes,
      ...diagnosticTypes,
      ...referralTypes,
    ]);
    expect(PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES).toEqual([
      ...PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES,
      ...opTypes,
      ...inpatientTypes.filter(
        (eventType) => !PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES.includes(eventType),
      ),
    ]);
    expect(PATHWAY_PROJECTOR_GENERATION_5_EVENT_TYPES).toEqual([
      ...PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES,
      ...EMERGENCY_PATHWAY_EVENT_TYPES_V1.filter(
        (eventType) => !PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES.includes(eventType),
      ),
    ]);
    expect(PATHWAY_PROJECTOR_GENERATION_6_EVENT_TYPES).toEqual([
      ...PATHWAY_PROJECTOR_GENERATION_5_EVENT_TYPES,
      ...EMERGENCY_PATHWAY_EVENT_TYPES.filter(
        (eventType) => !PATHWAY_PROJECTOR_GENERATION_5_EVENT_TYPES.includes(eventType),
      ),
    ]);
    expect(pathwayProjectorRegistryV1.eventTypes).toEqual(expectedTypes);
    expect(pathwayProjectorRegistryV1.size).toBe(6);
    expect(pathwayProjectorRegistryV2.eventTypes).toEqual(PATHWAY_PROJECTOR_GENERATION_2_EVENT_TYPES);
    expect(pathwayProjectorRegistryV3.eventTypes).toEqual(PATHWAY_PROJECTOR_GENERATION_3_EVENT_TYPES);
    expect(pathwayProjectorRegistryV4.eventTypes).toEqual(PATHWAY_PROJECTOR_GENERATION_4_EVENT_TYPES);
    expect(pathwayProjectorRegistryV5.eventTypes).toEqual(PATHWAY_PROJECTOR_GENERATION_5_EVENT_TYPES);
    expect(pathwayProjectorRegistry).toBe(pathwayProjectorRegistryV6);
    expect(pathwayProjectorRegistry.eventTypes).toEqual(PATHWAY_PROJECTOR_GENERATION_6_EVENT_TYPES);
    expect(pathwayProjectorRegistry.size).toBe(50);
    expect(isPathwayProjectorRegistry(pathwayProjectorRegistry)).toBe(true);
    expect(isPathwayProjectorRegistry(pathwayProjectorRegistryV1)).toBe(true);

    for (const eventType of expectedTypes) {
      expect(pathwayProjectorRegistry.resolve(eventType)).toEqual(expect.any(Function));
      expect(Object.isFrozen(pathwayProjectorRegistry.resolve(eventType))).toBe(true);
    }
    expect(pathwayProjectorRegistry.resolve('order.created')).toBeUndefined();
    expect(pathwayProjectorRegistry.resolve('referral.requested')).toEqual(expect.any(Function));
    expect(pathwayProjectorRegistry.resolve('appointment.child_resource_linked'))
      .toEqual(expect.any(Function));
    expect(pathwayProjectorRegistry.resolve('admission.diagnostic_resource_linked'))
      .toEqual(expect.any(Function));
    expect(pathwayProjectorRegistry.resolve('emergency.visit.destination_closed'))
      .toEqual(expect.any(Function));
  });

  it('rejects duplicate and malformed registrations', () => {
    const handler = async () => ({});
    expect(() => createPathwayProjectorRegistry({
      generation: 2004,
      entries: [['test.event', handler], ['test.event', handler]],
    })).toThrow(/duplicate/i);
    expect(() => createPathwayProjectorRegistry({ generation: 0, entries: [] })).toThrow(/generation/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2005, entries: null })).toThrow(/entries/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2006, entries: [['', handler]] })).toThrow(/malformed/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2007, entries: [[' test.event', handler]] })).toThrow(/malformed/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2008, entries: [['test.event', null]] })).toThrow(/function/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2009, entries: [{ eventType: 'test.event', handler }] })).toThrow(/tuple/i);
  });

  it('copies and freezes registry membership', () => {
    const mutableEntries = [['test.event', async () => ({ observed: true })]];
    const registry = createPathwayProjectorRegistry({ generation: 2003, entries: mutableEntries });

    mutableEntries[0][0] = 'changed.event';
    mutableEntries.push(['another.event', async () => ({})]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.eventTypes)).toBe(true);
    expect(registry.eventTypes).toEqual(['test.event']);
    expect(registry.resolve('test.event')).toEqual(expect.any(Function));
    expect(registry.resolve('changed.event')).toBeUndefined();
    expect(() => registry.eventTypes.push('mutated.event')).toThrow();
  });

  it('reserves every shipped generation while allowing changed later generations', () => {
    const observer = async () => ({ observed: true });
    const allGenerationOneEntries = expectedTypes.map((eventType) => [eventType, observer]);

    expect(() => createPathwayProjectorRegistry({
      generation: 1,
      entries: allGenerationOneEntries.slice(1),
    })).toThrow(/generation 1.*canonical/i);
    expect(() => createPathwayProjectorRegistry({
      generation: 1,
      entries: [...allGenerationOneEntries, ['test.extra', observer]],
    })).toThrow(/generation 1.*canonical/i);
    expect(() => createPathwayProjectorRegistry({
      generation: 1,
      entries: [...allGenerationOneEntries].reverse(),
    })).toThrow(/generation 1.*canonical/i);

    expect(() => createPathwayProjectorRegistry({
      generation: 2,
      entries: [['test.replacement', observer]],
    })).toThrow(/generation 2.*canonical/i);
    expect(() => createPathwayProjectorRegistry({
      generation: 3,
      entries: [['test.replacement', observer]],
    })).toThrow(/generation 3.*canonical/i);
    expect(() => createPathwayProjectorRegistry({
      generation: 4,
      entries: [['test.replacement', observer]],
    })).toThrow(/generation 4.*canonical/i);
    expect(() => createPathwayProjectorRegistry({
      generation: 5,
      entries: [['test.replacement', observer]],
    })).toThrow(/generation 5.*canonical/i);

    expect(syntheticRegistry.eventTypes).toEqual(['test.changed']);
    expect(syntheticRegistry.resolve('test.changed')).toBe(syntheticObserver);
    expect(() => createPathwayProjectorRegistry({
      generation: 2002,
      entries: [['test.replacement', observer]],
    })).toThrow(/generation 2002.*already registered/i);
  });

  it('requires constructor provenance for every generation before database work', async () => {
    const queryRaw = jest.fn();
    const prismaMock = { $queryRawUnsafe: queryRaw };
    const transaction = jest.fn(async (callback) => callback(prismaMock));
    prismaMock.$transaction = transaction;
    jest.unstable_mockModule('../../lib/prisma.js', () => ({
      default: prismaMock,
      setTenantTx: jest.fn(),
    }));
    const { runPathwayProjectorShadowTick } = await import(
      '../../services/events/pathwayProjectorService.js'
    );
    const resolve = () => async () => ({ observed: true });
    const handcraftedRegistry = {
      generation: 1,
      eventTypes: [...expectedTypes],
      resolve,
    };

    await expect(runPathwayProjectorShadowTick({ registry: handcraftedRegistry })).rejects.toMatchObject({
      code: 'PATHWAY_PROJECTOR_REGISTRY_PROVENANCE_MISMATCH',
    });
    expect(queryRaw).not.toHaveBeenCalled();

    const handcraftedGenerationTwo = {
      generation: 2,
      eventTypes: ['test.changed'],
      resolve,
    };
    await expect(runPathwayProjectorShadowTick({
      generation: 2,
      registry: handcraftedGenerationTwo,
    })).rejects.toMatchObject({
      code: 'PATHWAY_PROJECTOR_REGISTRY_PROVENANCE_MISMATCH',
    });
    expect(queryRaw).not.toHaveBeenCalled();

    expect(isPathwayProjectorRegistry(syntheticRegistry)).toBe(true);
    const completedOffset = {
      consumer_key: PATHWAY_PROJECTOR_CONSUMER_KEY,
      generation: 2002,
      historical_cutoff_event_id: '0',
      backfill_cursor_event_id: '0',
      backfill_completed_at: new Date(),
      registered_at: new Date(),
      updated_at: new Date(),
    };
    queryRaw
      .mockResolvedValueOnce([completedOffset])
      .mockResolvedValueOnce([completedOffset])
      .mockResolvedValueOnce([completedOffset])
      .mockResolvedValueOnce([]);
    await expect(runPathwayProjectorShadowTick({
      generation: 2002,
      registry: syntheticRegistry,
    })).resolves.toEqual({
      materialized: 0,
      claimed: 0,
      handled: 0,
      ignored: 0,
      retried: 0,
      dead: 0,
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(4);
  });

  it('fences every claimed-row completion path on the attempt epoch', () => {
    const sourcePath = fileURLToPath(new URL(
      '../../services/events/pathwayProjectorService.js',
      import.meta.url,
    ));
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain('row.attempts !== normalizedClaim.attempts');
    expect(source.match(/AND attempts = \$6::integer/g)).toHaveLength(2);
    expect(source).toContain('AND i.attempts = stale.attempts');
  });

  it('emits count-only warnings for dead-letter transitions', () => {
    const sourcePath = fileURLToPath(new URL(
      '../../services/events/pathwayProjectorService.js',
      import.meta.url,
    ));
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain(
      "logger.warn('Pathway projector stale lease reaper dead-lettered rows', { dead });",
    );
    expect(source).toContain(
      "logger.warn('Pathway projector shadow tick dead-lettered rows', { dead: counts.dead });",
    );
  });

  it('runs pure no-op observers that report bounded shadow metadata only', async () => {
    for (const eventType of expectedTypes) {
      const observer = pathwayProjectorRegistryV1.resolve(eventType);
      const result = await observer({
        tx: { forbiddenWriteCapability: true },
        event: { event_type: eventType, payload: { phi: 'must-not-return' } },
      });
      expect(result).toEqual({
        consumer_key: 'care_pathway_projector',
        generation: 1,
        event_type: eventType,
        shadow_observed: true,
      });
      expect(Object.isFrozen(result)).toBe(true);
    }

    const sourcePath = fileURLToPath(new URL('../../services/events/pathwayProjectorRegistry.js', import.meta.url));
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toMatch(/from ['"].*prisma/i);
    expect(source).not.toMatch(/\$queryRaw|\$executeRaw|publishEvent|notification|timeline|audit/i);
  });
});
