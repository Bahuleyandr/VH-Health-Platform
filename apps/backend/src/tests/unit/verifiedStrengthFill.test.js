// Unit tests for the drug-reference importer's verified-strength fill (pure logic).
import { parseStrength, compositionKey } from '../../services/pharmacy/compositionParser.js';
import {
  strengthTextFromMolecules, strengthSignature, strengthsAgree, resolveImportStrength,
} from '../../services/pharmacy/verifiedStrengthFill.js';

const deps = { parseStrength, compositionKey };
const mol = (molecule, v, u) => ({ molecule, strength_value: v, strength_unit: u });

describe('strengthTextFromMolecules', () => {
  test('single molecule → "N unit"', () => {
    expect(strengthTextFromMolecules([mol('amlodipine', 5, 'mg')])).toBe('5 mg');
  });
  test('combo → slash form, molecule-name sorted (deterministic)', () => {
    expect(strengthTextFromMolecules([mol('clavulanic acid', 125, 'mg'), mol('cefuroxime', 500, 'mg')]))
      .toBe('500 mg / 125 mg');
  });
  test('any missing strength → empty (never a partial guess)', () => {
    expect(strengthTextFromMolecules([mol('paracetamol', 500, 'mg'), mol('caffeine', null, null)])).toBe('');
    expect(strengthTextFromMolecules([])).toBe('');
  });
});

describe('strengthsAgree (content-based, format-tolerant)', () => {
  test('slash and plus notations of the same strengths agree', () => {
    expect(strengthsAgree(parseStrength('500 mg / 125 mg'), parseStrength('500 mg + 125 mg'))).toBe(true);
  });
  test('same single strength agrees; different disagrees', () => {
    expect(strengthsAgree(parseStrength('5 mg'), parseStrength('5 mg'))).toBe(true);
    expect(strengthsAgree(parseStrength('10 mg'), parseStrength('5 mg'))).toBe(false);
  });
  test('an unparseable/empty strength never agrees', () => {
    expect(strengthsAgree(parseStrength('No strength here'), parseStrength('5 mg'))).toBe(false);
  });
});

describe('strengthSignature', () => {
  test('is order-independent and canonical', () => {
    expect(strengthSignature([mol('b', 10, 'mg'), mol('a', 5, 'mg')]))
      .toBe(strengthSignature([mol('a', 5, 'mg'), mol('b', 10, 'mg')]));
  });
});

describe('resolveImportStrength', () => {
  const amlo = { molecules: [mol('amlodipine', 5, 'mg')], ambiguous: false };

  test('fills a strength-less catalog name from the verified value', () => {
    const r = resolveImportStrength({ catalogName: 'Amlosafe Tablet', compKey: 'amlodipine', verified: amlo }, deps);
    expect(r.provenance).toBe('aushadhi_verified');
    expect(r.strength.key).toBe('5mg');
    expect(r.mismatch).toBe(false);
  });

  test('keeps the catalog strength when it agrees (no mismatch)', () => {
    const r = resolveImportStrength({ catalogName: 'Amlosafe 5mg Tablet', compKey: 'amlodipine', verified: amlo }, deps);
    expect(r.provenance).toBe('catalog_name');
    expect(r.mismatch).toBe(false);
  });

  test('flags a mismatch when the catalog strength disagrees, keeping the catalog value', () => {
    const r = resolveImportStrength({ catalogName: 'Amlosafe 10mg Tablet', compKey: 'amlodipine', verified: amlo }, deps);
    expect(r.mismatch).toBe(true);
    expect(r.strength.key).toBe('10mg');            // pharmacist text preserved
    expect(r.verifiedStrength.key).toBe('5mg');     // recorded for curation
  });

  test('never fills from an ambiguous brand (two verified strengths)', () => {
    const r = resolveImportStrength({ catalogName: 'Amlosafe Tablet', compKey: 'amlodipine', verified: { molecules: null, ambiguous: true } }, deps);
    expect(r.provenance).toBe('catalog_name');
    expect(r.strength.key).toBeNull();
  });

  test('never fills when the verified molecules are a different composition', () => {
    const r = resolveImportStrength({ catalogName: 'Foo Tablet', compKey: 'atorvastatin', verified: amlo }, deps);
    expect(r.provenance).toBe('catalog_name');
    expect(r.strength.key).toBeNull();
  });

  test('fills a strength-less combo (Levo+Mont) with the correct per-ingredient split', () => {
    const verified = { molecules: [mol('levocetirizine', 5, 'mg'), mol('montelukast', 10, 'mg')], ambiguous: false };
    const compKey = compositionKey('levocetirizine + montelukast').key;
    const r = resolveImportStrength({ catalogName: 'Almont LC Tablet', compKey, verified }, deps);
    expect(r.provenance).toBe('aushadhi_verified');
    expect(r.strength.key).toBe('5mg/10mg');
    expect(r.strength.components).toHaveLength(2);
  });
});
