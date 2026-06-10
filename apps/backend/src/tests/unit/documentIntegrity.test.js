// Roadmap C4 — document integrity pure helpers.

import { stableStringify, contentHashOf, SIGNABLE_DOCUMENTS } from '../../services/clinical/documentIntegrityService.js';

describe('stableStringify', () => {
  test('is key-order independent (canonical form)', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableStringify(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });
  test('arrays keep order; primitives + null round-trip', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify('s')).toBe('"s"');
  });
});

describe('contentHashOf', () => {
  test('same content → same sha256; any change → different hash', () => {
    const doc = { id: 1, content: { plan: 'rest' }, title: 'Note' };
    const h1 = contentHashOf(doc);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHashOf({ title: 'Note', id: 1, content: { plan: 'rest' } })).toBe(h1);
    expect(contentHashOf({ ...doc, title: 'Note edited' })).not.toBe(h1);
  });
});

describe('signable document registry', () => {
  test('covers the core clinical documents with volatile columns excluded', () => {
    expect(Object.keys(SIGNABLE_DOCUMENTS).sort()).toEqual(
      ['clinical_note', 'consent', 'discharge_summary', 'encounter', 'radiology_report'],
    );
    expect(SIGNABLE_DOCUMENTS.clinical_note.exclude).toContain('is_signed');
    expect(SIGNABLE_DOCUMENTS.encounter.exclude).toContain('status_history');
  });
});
