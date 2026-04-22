import {
  classifyDocumentType,
  extractStructuredDocumentFacts,
} from '../../services/ai/documentIntelligenceService.js';

describe('document intelligence helpers', () => {
  it('classifies discharge summaries from metadata and body text', () => {
    expect(classifyDocumentType({
      fileName: 'apollo-discharge-summary.pdf',
      rawText: 'Hospital course: discharged on 2026-04-20 with follow-up',
    })).toBe('external_discharge_summary');
  });

  it('respects an explicit non-other source type', () => {
    expect(classifyDocumentType({
      sourceType: 'abdm_document',
      rawText: 'plain text',
    })).toBe('abdm_document');
  });

  it('extracts medication, investigation, diagnosis, and follow-up lines', () => {
    const facts = extractStructuredDocumentFacts(`
      Patient Name: Meera Rao
      MRN: VH-12345
      Diagnosis: Community acquired pneumonia
      Tab Azithromycin 500 mg OD for 3 days
      CBC: WBC 14000, Hb 12 g
      Chest X-ray: right lower zone opacity
      Follow-up after 7 days
    `, 'external_discharge_summary');

    expect(facts.patient_identifiers.mrn).toContain('MRN: VH-12345');
    expect(facts.medications[0].text).toMatch(/Azithromycin/i);
    expect(facts.investigations.some((item) => /CBC/i.test(item.text))).toBe(true);
    expect(facts.diagnoses[0].text).toMatch(/pneumonia/i);
    expect(facts.follow_up[0].text).toMatch(/7 days/i);
    expect(facts.confidence).toBeGreaterThan(50);
  });

  it('extracts payer fields from insurance forms', () => {
    const facts = extractStructuredDocumentFacts(`
      Insurer: Care Health
      Policy Number: POL-998877
      Claim No: CLM-123456
    `, 'insurance_form');

    expect(facts.billing_fields.policy_number).toBe('POL-998877');
    expect(facts.billing_fields.claim_number).toBe('CLM-123456');
    expect(facts.billing_fields.payer_name).toBe('Care Health');
  });

  it('returns a safe empty-ish structure for blank OCR text', () => {
    const facts = extractStructuredDocumentFacts('', 'other');
    expect(facts.line_count).toBe(0);
    expect(facts.medications).toEqual([]);
    expect(facts.investigations).toEqual([]);
    expect(facts.confidence).toBe(25);
  });
});
