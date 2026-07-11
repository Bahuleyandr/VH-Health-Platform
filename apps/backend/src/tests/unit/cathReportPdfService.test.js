import { renderCathReportPdf } from '../../services/documents/cathReportPdfService.js';

describe('cathReportPdfService', () => {
  test('renders a signed report with sections, coded fields, signer, and chronological addenda', async () => {
    const buffer = await renderCathReportPdf({
      id: 51,
      status: 'signed',
      report_type: 'ptca',
      patient_uid: '11111111-1111-4111-8111-111111111111',
      patient_name: 'Test Patient',
      case_id: 42,
      requested_procedure: 'PTCA',
      procedure_log_id: 7,
      procedure_type: 'PTCA',
      procedure_ended_at: '2026-07-11T09:00:00.000Z',
      procedure_operators: [{ name: 'Test Operator' }],
      encounter_id: '22222222-2222-4222-8222-222222222222',
      template_version: 1,
      narrative_sections: [
        { key: 'findings', title: 'Findings', text: 'Synthetic test finding.' },
        { key: 'result', title: 'Result', text: 'Synthetic test result.' },
      ],
      coded_fields: {
        vessels_treated: ['LAD'],
        stents: [{ model: 'Synthetic stent', length_mm: 18 }],
      },
      signed_by: '33333333-3333-4333-8333-333333333333',
      signed_by_name: 'Test Signer',
      signed_by_role: 'DOCTOR',
      signed_at: '2026-07-11T10:00:00.000Z',
      addenda: [
        {
          id: 91,
          author_uid: '33333333-3333-4333-8333-333333333333',
          author_name: 'Test Signer',
          reason: 'Clarification',
          narrative: 'Synthetic addendum.',
          created_at: '2026-07-11T11:00:00.000Z',
        },
      ],
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  test('rejects printable output for unsigned reports', async () => {
    await expect(renderCathReportPdf({ status: 'preliminary' }))
      .rejects.toMatchObject({ code: 'CATH_REPORT_PDF_REQUIRES_SIGNED' });
  });
});
