import { classifyInferenceResults } from '../../services/ai/imagingAiService.js';
import {
  buildDicomwebStudyQueryUrl,
  fetchPacsStudyMetadata,
  normalizeDicomwebStudyMetadata,
  normalizeOrthancStudyMetadata,
  resolvePacsConfig,
} from '../../services/ai/imagingPacsAdapterService.js';

describe('imaging AI inference classifier', () => {
  it('returns normal when nothing meets the confidence threshold', () => {
    const out = classifyInferenceResults([
      { label: 'pneumonia', confidence: 0.2 },
      { label: 'opacity', confidence: 0.15 },
    ]);
    expect(out.overall_severity).toBe('normal');
    expect(out.findings.length).toBe(0);
  });

  it('classifies a confident pneumothorax as critical', () => {
    const out = classifyInferenceResults([
      { label: 'Pneumothorax', confidence: 0.78 },
      { label: 'cardiomegaly', confidence: 0.62 },
    ]);
    expect(out.overall_severity).toBe('critical');
    expect(out.findings[0].severity).toBe('critical');
    expect(out.findings[0].label).toBe('pneumothorax');
  });

  it('falls back to actionable when only actionable labels fire', () => {
    const out = classifyInferenceResults([
      { label: 'pneumonia', confidence: 0.82 },
      { label: 'pleural effusion', confidence: 0.64 },
    ]);
    expect(out.overall_severity).toBe('actionable');
    expect(out.findings[0].severity).toBe('actionable');
  });

  it('returns incidental when only low-confidence labels fire', () => {
    const out = classifyInferenceResults([
      { label: 'calcified granuloma', confidence: 0.4 },
    ]);
    expect(out.overall_severity).toBe('incidental');
  });

  it('sorts findings by severity then confidence', () => {
    const out = classifyInferenceResults([
      { label: 'pneumonia', confidence: 0.9 },
      { label: 'pneumothorax', confidence: 0.55 },
      { label: 'opacity', confidence: 0.7 },
    ]);
    expect(out.findings[0].severity).toBe('critical');
    expect(out.findings[0].label).toBe('pneumothorax');
    expect(out.findings[1].label).toBe('pneumonia');
  });

  it('tops out confidence_pct at the max confidence seen', () => {
    const out = classifyInferenceResults([
      { label: 'consolidation', confidence: 0.85 },
      { label: 'opacity', confidence: 0.65 },
    ]);
    expect(out.confidence_pct).toBe(85);
  });

  it('handles non-array or empty input gracefully', () => {
    expect(classifyInferenceResults(null)).toEqual({
      findings: [],
      overall_severity: 'normal',
      confidence_pct: 0,
    });
    expect(classifyInferenceResults([])).toEqual({
      findings: [],
      overall_severity: 'normal',
      confidence_pct: 0,
    });
  });
});

describe('imaging PACS adapter', () => {
  const dicomwebPayload = [{
    '0020000D': { vr: 'UI', Value: ['1.2.840.113619.2.55.3'] },
    '00080050': { vr: 'SH', Value: ['ACC-123'] },
    '00080020': { vr: 'DA', Value: ['20260422'] },
    '00080061': { vr: 'CS', Value: ['CT', 'MR'] },
    '00180015': { vr: 'CS', Value: ['CHEST'] },
    '00081030': { vr: 'LO', Value: ['CT Chest'] },
    '00100020': { vr: 'LO', Value: ['PACS-PID-1'] },
    '00100010': { vr: 'PN', Value: [{ Alphabetic: 'Masked^Patient' }] },
    '00201206': { vr: 'IS', Value: [3] },
    '00201208': { vr: 'IS', Value: [128] },
  }];

  it('normalizes DICOMweb QIDO-RS study metadata', () => {
    const study = normalizeDicomwebStudyMetadata(dicomwebPayload);
    expect(study).toEqual(expect.objectContaining({
      study_instance_uid: '1.2.840.113619.2.55.3',
      accession_number: 'ACC-123',
      modality: 'CT',
      body_part: 'CHEST',
      study_date: '2026-04-22',
      series_count: 3,
      instance_count: 128,
      dicom_patient_identifier: 'PACS-PID-1',
      dicom_patient_name_present: true,
      source_format: 'dicomweb',
    }));
  });

  it('normalizes Orthanc native study metadata', () => {
    const study = normalizeOrthancStudyMetadata({
      ID: 'orthanc-study-id',
      MainDicomTags: {
        StudyInstanceUID: '2.25.123',
        AccessionNumber: 'ORTH-9',
        StudyDate: '20260420',
        Modality: 'CR',
        BodyPartExamined: 'CHEST',
        StudyDescription: 'Portable chest',
      },
      PatientMainDicomTags: {
        PatientID: 'PACS-42',
        PatientName: 'Hidden^Patient',
      },
      Series: ['s1', 's2'],
      Instances: ['i1', 'i2', 'i3'],
    });
    expect(study).toEqual(expect.objectContaining({
      study_instance_uid: '2.25.123',
      accession_number: 'ORTH-9',
      modality: 'CR',
      series_count: 2,
      instance_count: 3,
      source_format: 'orthanc_native',
      pacs_study_id: 'orthanc-study-id',
    }));
  });

  it('builds a DICOMweb study query URL with encoded identifiers', () => {
    const url = buildDicomwebStudyQueryUrl({
      baseUrl: 'https://pacs.example.test/dicom-web/',
      studyInstanceUid: '1.2.3',
      accessionNumber: 'ACC 1',
    });
    expect(url).toBe('https://pacs.example.test/dicom-web/studies?StudyInstanceUID=1.2.3&AccessionNumber=ACC+1');
  });

  it('returns structured config skips when PACS is not configured', () => {
    const config = resolvePacsConfig({
      env: { CLINICAL_AI_PACS_PROVIDER: 'dicomweb' },
      tenantRegion: 'IN-TN',
    });
    expect(config.configured).toBe(false);
    expect(config.reason).toBe('pacs_base_url_not_configured');
  });

  it('fetches and normalizes configured DICOMweb metadata', async () => {
    const calls = [];
    const result = await fetchPacsStudyMetadata({
      studyInstanceUid: '1.2.840.113619.2.55.3',
      tenantRegion: 'IN-TN',
      env: {
        CLINICAL_AI_PACS_PROVIDER: 'dicomweb',
        CLINICAL_AI_PACS_BASE_URL: 'https://pacs.example.test/dicom-web',
        CLINICAL_AI_PACS_ALLOWED_REGIONS: 'IN-TN',
      },
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return {
          ok: true,
          status: 200,
          json: async () => dicomwebPayload,
        };
      },
    });
    expect(result.status).toBe('found');
    expect(result.study.study_instance_uid).toBe('1.2.840.113619.2.55.3');
    expect(calls[0].url).toContain('/studies?StudyInstanceUID=1.2.840.113619.2.55.3');
    expect(calls[0].options.method).toBe('GET');
  });
});
