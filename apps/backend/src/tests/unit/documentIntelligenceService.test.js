import {
  classifyDocumentType,
  extractStructuredDocumentFacts,
} from '../../services/ai/documentIntelligenceService.js';
import {
  extractNativePdfText,
  extractTextFromDocumentUpload,
} from '../../services/ai/documentOcrAdapter.js';

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

  it('extracts raw text from text uploads without external OCR tooling', async () => {
    const result = await extractTextFromDocumentUpload({
      buffer: Buffer.from('Diagnosis: Pneumonia\nTab Azithromycin 500 mg OD', 'utf8'),
      mimeType: 'text/plain',
      fileName: 'outside-summary.txt',
    });

    expect(result.status).toBe('completed');
    expect(result.provider).toBe('native_text');
    expect(result.raw_text).toMatch(/Azithromycin/);
    expect(result.file_hash).toHaveLength(64);
  });

  it('extracts selectable PDF text from literal text streams', () => {
    const pdf = Buffer.from(`
      %PDF-1.4
      1 0 obj << /Type /Page >> endobj
      stream
      BT (Diagnosis: Community acquired pneumonia) Tj
      (Tab Amoxicillin clavulanate 625 mg BD) Tj
      ET
      endstream
      %%EOF
    `, 'latin1');

    const text = extractNativePdfText(pdf);
    expect(text).toMatch(/Community acquired pneumonia/);
    expect(text).toMatch(/Amoxicillin clavulanate/);
  });

  it('keeps image uploads reviewable when local OCR is not configured', async () => {
    const previousProvider = process.env.CLINICAL_AI_OCR_PROVIDER;
    delete process.env.CLINICAL_AI_OCR_PROVIDER;
    try {
      const result = await extractTextFromDocumentUpload({
        buffer: Buffer.from('not-a-real-png', 'utf8'),
        mimeType: 'image/png',
        fileName: 'prescription.png',
      });

      expect(result.status).toBe('no_text');
      expect(result.provider).toBe('image_metadata_only');
      expect(result.safety_flags.some((flag) => flag.code === 'LOCAL_OCR_NOT_CONFIGURED')).toBe(true);
    } finally {
      if (previousProvider === undefined) delete process.env.CLINICAL_AI_OCR_PROVIDER;
      else process.env.CLINICAL_AI_OCR_PROVIDER = previousProvider;
    }
  });
});
