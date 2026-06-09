// Roadmap B4 — PACS helpers (pure).

import {
  getPacsConfig,
  buildViewerUrl,
  toDicomDate,
  toDicomTime,
  formatWorklistItem,
} from '../../services/radiology/pacsService.js';

const ENV = {
  PACS_DICOMWEB_URL: 'http://orthanc:8042/dicom-web',
  PACS_VIEWER_URL: 'https://imaging.vhhealth.app/',
  PACS_AET: 'VHHEALTH',
};

describe('pacs config + viewer url', () => {
  test('disabled when no env configured', () => {
    expect(getPacsConfig({})).toMatchObject({ enabled: false, dicomweb_url: null, viewer_url: null, aet: 'VHHEALTH' });
  });
  test('builds OHIF deep links with trailing-slash tolerance and encoding', () => {
    expect(buildViewerUrl('1.2.840.113619.2.55.3', ENV))
      .toBe('https://imaging.vhhealth.app/viewer?StudyInstanceUIDs=1.2.840.113619.2.55.3');
    expect(buildViewerUrl(null, ENV)).toBeNull();
    expect(buildViewerUrl('1.2.3', {})).toBeNull();
  });
});

describe('DICOM date/time formatting', () => {
  test('formats DA and TM with zero padding', () => {
    const d = new Date(2026, 5, 7, 9, 5, 3); // 2026-06-07 09:05:03 local
    expect(toDicomDate(d)).toBe('20260607');
    expect(toDicomTime(d)).toBe('090503');
  });
  test('invalid dates return null', () => {
    expect(toDicomDate('garbage')).toBeNull();
    expect(toDicomTime(undefined)).toBeNull();
  });
});

describe('worklist item shaping', () => {
  test('maps an order row to an MWL-shaped item', () => {
    const item = formatWorklistItem({
      id: 42,
      patient_uid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      patient_db_id: 7,
      patient_name: 'Test Patient',
      patient_mrn: 'MRN-0007',
      birthday: new Date(1980, 0, 2),
      gender: 'male',
      modality: 'ct',
      body_part: 'Chest',
      clinical_indication: 'Cough 3 weeks',
      priority: 'urgent',
      created_at: new Date(2026, 5, 9, 14, 30, 0),
    }, ENV);
    expect(item).toMatchObject({
      accession_number: 'RAD-42',
      modality: 'CT',
      requested_procedure: 'ct Chest',
      priority: 'urgent',
      scheduled_station_aet: 'VHHEALTH',
      scheduled_date: '20260609',
      scheduled_time: '143000',
    });
    expect(item.patient).toMatchObject({ patient_id: 'MRN-0007', name: 'Test Patient', birth_date: '19800102', sex: 'M' });
  });
  test('falls back to db id and unknown sex', () => {
    const item = formatWorklistItem({ id: 1, patient_db_id: 9, modality: 'XR', created_at: new Date() }, ENV);
    expect(item.patient.patient_id).toBe('9');
    expect(item.patient.sex).toBe('O');
    expect(item.patient.name).toBe('UNKNOWN');
  });
});
