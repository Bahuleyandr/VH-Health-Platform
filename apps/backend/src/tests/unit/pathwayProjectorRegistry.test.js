import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import {
  PATHWAY_PROJECTOR_CONSUMER_KEY,
  PATHWAY_PROJECTOR_GENERATION,
  PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES,
  createPathwayProjectorRegistry,
  isPathwayProjectorRegistry,
  pathwayProjectorRegistry,
} from '../../services/events/pathwayProjectorRegistry.js';

describe('pathwayProjectorRegistry', () => {
  const expectedTypes = [
    'clinical.handover.created',
    'clinical.handover.acknowledged',
    'clinical.prehospital_handover.created',
    'clinical.prehospital_handover.accepted',
    'clinical_document.discharge_summary.saved',
    'clinical_document.discharge_summary.signed',
  ];
  const generationTwoObserver = async () => ({ observed: true });
  const generationTwoRegistry = createPathwayProjectorRegistry({
    generation: 2,
    entries: [['test.changed', generationTwoObserver]],
  });

  it('exposes exactly the six generation-1 shadow observers', () => {
    expect(PATHWAY_PROJECTOR_CONSUMER_KEY).toBe('care_pathway_projector');
    expect(PATHWAY_PROJECTOR_GENERATION).toBe(1);
    expect(PATHWAY_PROJECTOR_GENERATION_1_EVENT_TYPES).toEqual(expectedTypes);
    expect(pathwayProjectorRegistry.eventTypes).toEqual(expectedTypes);
    expect(pathwayProjectorRegistry.size).toBe(6);
    expect(isPathwayProjectorRegistry(pathwayProjectorRegistry)).toBe(true);

    for (const eventType of expectedTypes) {
      expect(pathwayProjectorRegistry.resolve(eventType)).toEqual(expect.any(Function));
      expect(Object.isFrozen(pathwayProjectorRegistry.resolve(eventType))).toBe(true);
    }
    expect(pathwayProjectorRegistry.resolve('order.created')).toBeUndefined();
    expect(pathwayProjectorRegistry.resolve('referral.requested')).toBeUndefined();
  });

  it('rejects duplicate and malformed registrations', () => {
    const handler = async () => ({});
    expect(() => createPathwayProjectorRegistry({
      generation: 2,
      entries: [['test.event', handler], ['test.event', handler]],
    })).toThrow(/duplicate/i);
    expect(() => createPathwayProjectorRegistry({ generation: 0, entries: [] })).toThrow(/generation/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2, entries: null })).toThrow(/entries/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2, entries: [['', handler]] })).toThrow(/malformed/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2, entries: [[' test.event', handler]] })).toThrow(/malformed/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2, entries: [['test.event', null]] })).toThrow(/function/i);
    expect(() => createPathwayProjectorRegistry({ generation: 2, entries: [{ eventType: 'test.event', handler }] })).toThrow(/tuple/i);
  });

  it('copies and freezes registry membership', () => {
    const mutableEntries = [['test.event', async () => ({ observed: true })]];
    const registry = createPathwayProjectorRegistry({ generation: 3, entries: mutableEntries });

    mutableEntries[0][0] = 'changed.event';
    mutableEntries.push(['another.event', async () => ({})]);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.eventTypes)).toBe(true);
    expect(registry.eventTypes).toEqual(['test.event']);
    expect(registry.resolve('test.event')).toEqual(expect.any(Function));
    expect(registry.resolve('changed.event')).toBeUndefined();
    expect(() => registry.eventTypes.push('mutated.event')).toThrow();
  });

  it('reserves generation 1 to canonical semantics while allowing changed later generations', () => {
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

    expect(generationTwoRegistry.eventTypes).toEqual(['test.changed']);
    expect(generationTwoRegistry.resolve('test.changed')).toBe(generationTwoObserver);
    expect(() => createPathwayProjectorRegistry({
      generation: 2,
      entries: [['test.replacement', observer]],
    })).toThrow(/generation 2.*already registered/i);
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

    expect(isPathwayProjectorRegistry(generationTwoRegistry)).toBe(true);
    const completedOffset = {
      consumer_key: PATHWAY_PROJECTOR_CONSUMER_KEY,
      generation: 2,
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
      generation: 2,
      registry: generationTwoRegistry,
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
      const observer = pathwayProjectorRegistry.resolve(eventType);
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
