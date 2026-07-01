import { compositionKey } from '../../services/pharmacy/compositionParser.js';

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
