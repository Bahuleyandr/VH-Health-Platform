import { buildPatientRecordExtractionSummary } from '../../controllers/appointment/appointmentDocumentController.js';

describe('appointment document controller extraction helpers', () => {
  it('builds the staff-facing extraction summary from intake columns', () => {
    const summary = buildPatientRecordExtractionSummary({
      id: 44n,
      document_type: 'prior_record',
      ai_intake_id: 12,
      ai_extraction_status: 'completed',
      ai_document_type: 'prescription',
      ai_reviewer_decision: 'pending',
      ai_reviewed_at: null,
      ai_reviewer_note: null,
      ai_extracted_fields: {
        confidence: 82,
        medications: [{ text: 'Tab Metformin 500 mg BD' }],
      },
      ai_normalized_sections: {
        summary: ['Diabetes follow-up prescription'],
      },
      ai_source_citations: [{ label: 'line 1' }],
      ai_safety_flags: [],
      ai_metadata: {
        ocr_status: 'completed',
        ocr_provider: 'native_text',
        text_char_count: 120,
      },
      ai_raw_text: 'Tab Metformin 500 mg BD',
    }, { includeRawText: true });

    expect(summary).toEqual(expect.objectContaining({
      intake_id: 12,
      extraction_status: 'completed',
      document_type: 'prescription',
      reviewer_decision: 'pending',
      confidence: 82,
      ocr_status: 'completed',
      ocr_provider: 'native_text',
      text_char_count: 120,
      raw_text: 'Tab Metformin 500 mg BD',
    }));
    expect(summary.normalized_sections.summary).toContain('Diabetes follow-up prescription');
    expect(summary.source_citations).toHaveLength(1);
  });

  it('returns null when a patient record has no linked intake', () => {
    expect(buildPatientRecordExtractionSummary({ id: 44n })).toBeNull();
  });
});
