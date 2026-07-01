import { compositionKey, parseStrength, parseForm, parseCatalogRow } from '../../services/pharmacy/compositionParser.js';

describe('compositionKey', () => {
  it('normalizes a single molecule', () => {
    const r = compositionKey('Paracetamol');
    expect(r.key).toBe('paracetamol');
    expect(r.activeIngredients).toEqual(['paracetamol']);
    expect(r.confidence).toBe('high');
  });

  it('splits + canonicalizes a combination, order-independent', () => {
    const a = compositionKey('Amoxicillin + Clavulanic acid');
    const b = compositionKey('Clavulanic Acid & Amoxicillin');
    expect(a.key).toBe('amoxicillin+clavulanic_acid');
    expect(a.key).toBe(b.key);
    expect(a.activeIngredients).toEqual(['amoxicillin', 'clavulanic_acid']);
  });

  it('expands known abbreviations via the alias map', () => {
    const r = compositionKey('Amoxicillin+Clav');
    expect(r.key).toBe('amoxicillin+clavulanic_acid');
  });

  it('flags empty/garbage input as low confidence', () => {
    const r = compositionKey('');
    expect(r.key).toBe('');
    expect(r.confidence).toBe('low');
  });
});

describe('parseStrength', () => {
  it('parses a simple strength + canonical key', () => {
    const r = parseStrength('Paracetamol 500mg');
    expect(r.display).toBe('500 mg');
    expect(r.key).toBe('500mg');
    expect(r.confidence).toBe('high');
  });

  it('normalizes units + spacing into the key (mcg/µg, spaces)', () => {
    expect(parseStrength('Levothyroxine 50 µg').key).toBe('50mcg');
    expect(parseStrength('Levothyroxine 50mcg').key).toBe('50mcg');
  });

  it('parses a ratio strength', () => {
    const r = parseStrength('Amoxicillin Syrup 125mg/5ml');
    expect(r.key).toBe('125mg/5ml');
  });

  it('extracts per-ingredient components only when explicit', () => {
    expect(parseStrength('Amox-Clav 500mg + 125mg').components)
      .toEqual([{ amount: 500, unit: 'mg' }, { amount: 125, unit: 'mg' }]);
    expect(parseStrength('Amoxicillin-Clavulanate 625').components).toBeNull();
  });

  it('returns null strength for a name with no dosage', () => {
    expect(parseStrength('Vitamin B Complex').key).toBeNull();
  });
});

describe('parseForm', () => {
  it('detects form + canonical key', () => {
    expect(parseForm('Paracetamol 1g Injection').formKey).toBe('injection');
    expect(parseForm('Ondansetron Syrup 2mg/5ml').formKey).toBe('syrup');
    expect(parseForm('Metformin 500mg').formKey).toBe('tablet'); // default oral solid
  });

  it('detects modified release', () => {
    expect(parseForm('Metformin 500mg SR').releaseKey).toBe('sr');
    expect(parseForm('Nifedipine XR 30mg').releaseKey).toBe('xr');
    expect(parseForm('Amoxicillin 500mg').releaseKey).toBeNull();
  });
});

describe('parseCatalogRow', () => {
  it('combines composition + strength + form with an overall confidence', () => {
    const r = parseCatalogRow({ name: 'Augmentin 625mg', generic_name: 'Amoxicillin+Clav' });
    expect(r.composition.key).toBe('amoxicillin+clavulanic_acid');
    expect(r.strength.key).toBe('625mg');
    // combo with a total-only strength → flagged for curation
    expect(r.curationReason).toBe('partial_strength');
  });
});
