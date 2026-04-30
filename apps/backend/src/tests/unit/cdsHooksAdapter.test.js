import {
  CDS_HOOKS_SERVICES,
  alertToCard,
  buildCardsResponse,
  buildDiscoveryResponse,
  extractEncounterId,
  extractMedicationNames,
  extractPatientUid,
  findServiceById,
  severityToIndicator,
} from '../../services/cds/cdsHooksAdapter.js';

describe('cdsHooksAdapter', () => {
  describe('severityToIndicator', () => {
    it.each([
      ['critical', 'critical'],
      ['CRITICAL', 'critical'],
      ['warning', 'warning'],
      ['high', 'warning'],
      ['info', 'info'],
      ['', 'info'],
      ['random', 'info'],
      [null, 'info'],
    ])('maps %s → %s', (input, expected) => {
      expect(severityToIndicator(input)).toBe(expected);
    });
  });

  describe('alertToCard', () => {
    it('returns null for an empty alert', () => {
      expect(alertToCard(null)).toBeNull();
      expect(alertToCard({})).toBeNull();
    });

    it('produces a CDS Hooks card with required fields', () => {
      const alert = {
        type: 'drug_interaction',
        severity: 'critical',
        title: 'Severe interaction: warfarin + ibuprofen',
        description: 'Increased bleeding risk; avoid concurrent use.',
        canOverride: true,
        sourceData: { interaction_id: 42 },
      };
      const card = alertToCard(alert);
      expect(card).toMatchObject({
        summary: alert.title,
        indicator: 'critical',
        source: { label: expect.any(String), url: expect.any(String) },
        detail: alert.description,
      });
      expect(card.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(card.extension?.vh_source_data?.interaction_id).toBe(42);
    });

    it('truncates summary at 140 chars', () => {
      const long = 'a'.repeat(200);
      const card = alertToCard({
        title: long,
        severity: 'warning',
        description: 'detail',
      });
      expect(card.summary.length).toBeLessThanOrEqual(140);
      expect(card.summary.endsWith('…')).toBe(true);
    });

    it('produces deterministic uuids for the same content', () => {
      const alert = {
        type: 'protocol_reminder',
        severity: 'warning',
        title: 'Sepsis bundle',
        description: 'Lactate pending',
      };
      expect(alertToCard(alert).uuid).toBe(alertToCard(alert).uuid);
    });

    it('records overrideReasons=[] when alert is non-overridable', () => {
      const card = alertToCard({
        title: 'Hard stop',
        severity: 'critical',
        description: '...',
        canOverride: false,
      });
      expect(card.overrideReasons).toEqual([]);
    });
  });

  describe('buildCardsResponse', () => {
    it('returns { cards: [] } for empty input', () => {
      expect(buildCardsResponse([])).toEqual({ cards: [] });
      expect(buildCardsResponse(null)).toEqual({ cards: [] });
    });

    it('converts each alert and filters empties', () => {
      const out = buildCardsResponse([
        { title: 'A', severity: 'info', description: 'a' },
        null,
        { title: 'B', severity: 'critical', description: 'b' },
      ]);
      expect(out.cards).toHaveLength(2);
      expect(out.cards[0].summary).toBe('A');
      expect(out.cards[1].indicator).toBe('critical');
    });
  });

  describe('extractPatientUid / extractEncounterId', () => {
    it('strips Patient/ and Encounter/ FHIR Reference prefixes', () => {
      expect(extractPatientUid({ patientId: 'Patient/abc-123' })).toBe('abc-123');
      expect(extractEncounterId({ encounterId: 'Encounter/xyz' })).toBe('xyz');
    });

    it('accepts bare UIDs', () => {
      expect(extractPatientUid({ patientId: 'plain-uid' })).toBe('plain-uid');
    });

    it('returns null when context lacks the field', () => {
      expect(extractPatientUid({})).toBeNull();
      expect(extractEncounterId(null)).toBeNull();
    });
  });

  describe('extractMedicationNames', () => {
    it('reads names from a FHIR Bundle medications context', () => {
      const context = {
        medications: {
          entry: [
            {
              resource: {
                resourceType: 'MedicationRequest',
                medicationCodeableConcept: { text: 'Warfarin 5 mg' },
              },
            },
            {
              resource: {
                resourceType: 'MedicationRequest',
                medicationCodeableConcept: { coding: [{ display: 'Ibuprofen 400 mg' }] },
              },
            },
          ],
        },
      };
      expect(extractMedicationNames(context)).toEqual(['Warfarin 5 mg', 'Ibuprofen 400 mg']);
    });

    it('reads names from a flat array', () => {
      const context = {
        medications: [
          'Amoxicillin',
          { name: 'Metoprolol' },
          { medication_name: 'Aspirin' },
        ],
      };
      expect(extractMedicationNames(context)).toEqual(['Amoxicillin', 'Metoprolol', 'Aspirin']);
    });

    it('returns empty array when no medications are supplied', () => {
      expect(extractMedicationNames({})).toEqual([]);
      expect(extractMedicationNames(null)).toEqual([]);
    });
  });

  describe('discovery + service lookup', () => {
    it('discovery response advertises every registered service', () => {
      const discovery = buildDiscoveryResponse();
      expect(discovery.services.length).toBe(CDS_HOOKS_SERVICES.length);
      for (const service of CDS_HOOKS_SERVICES) {
        const found = discovery.services.find((entry) => entry.id === service.id);
        expect(found).toBeDefined();
        expect(found.hook).toBe(service.hook);
        expect(found.title).toBeTruthy();
        expect(found.description).toBeTruthy();
      }
    });

    it('findServiceById returns service or null', () => {
      expect(findServiceById('vh-patient-view')?.hook).toBe('patient-view');
      expect(findServiceById('does-not-exist')).toBeNull();
    });

    it('every registered service uses a standard CDS Hooks hook id', () => {
      const STANDARD_HOOKS = new Set([
        'patient-view',
        'order-select',
        'order-sign',
        'order-dispatch',
        'medication-prescribe',
        'encounter-start',
        'encounter-discharge',
        'appointment-book',
      ]);
      for (const service of CDS_HOOKS_SERVICES) {
        expect(STANDARD_HOOKS.has(service.hook)).toBe(true);
      }
    });
  });
});
