import { randomUUID } from 'node:crypto';

import { resolveExternalInterfaceDisposition } from '../../config/externalInterfaceRecoveryCatalog.js';
import { registerExternalRecoveryOffset } from '../../services/integrations/externalInterfaceRecoveryService.js';
import { parseI06StudyLinkPayload } from '../../services/integrations/externalImagingStudyLinkRecoveryService.js';

const payload = Object.freeze({
  schema: 'vhhealth.i06.study-link/v1',
  radiology_order_id: 42,
  study_instance_uid: '1.2.826.0.1.3680043.8.498.42',
  accession_number: 'RAD-42',
  source_system: 'pacs-test',
  observed_at: '2026-08-02T06:30:00.000Z',
});

describe('I06 imaging study-link recovery', () => {
  test('parses only the registered exact study-link payload shape', () => {
    expect(parseI06StudyLinkPayload(JSON.stringify(payload))).toEqual({
      schema: payload.schema,
      radiologyOrderId: 42,
      studyInstanceUid: payload.study_instance_uid,
      accessionNumber: payload.accession_number,
      sourceSystem: payload.source_system,
      observedAt: payload.observed_at,
    });
  });

  test.each([
    [{ ...payload, schema: 'vhhealth.i06.study-link/v2' }],
    [{ ...payload, study_instance_uid: 'not-a-dicom-uid' }],
    [{ ...payload, unregistered: true }],
  ])('rejects an unregistered or drifted payload', (candidate) => {
    expect(() => parseI06StudyLinkPayload(JSON.stringify(candidate))).toThrow(
      expect.objectContaining({ code: 'I06_STUDY_LINK_PAYLOAD_INVALID' }),
    );
  });

  test('keeps the study-link high-water ledger separate from synchronous reads', async () => {
    expect(resolveExternalInterfaceDisposition({
      interfaceFamily: 'I06',
      subpath: 'study_link',
    })).toMatchObject({
      selectedSubpath: 'study_link',
      selectedDisposition: 'hwm_required',
      direction: 'inbound',
      facilityScope: 'tenant',
    });
    for (const subpath of ['worklist_read', 'metadata_read']) {
      expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I06', subpath }))
        .toMatchObject({ selectedSubpath: subpath, selectedDisposition: 'not_applicable_no_replayable_stream' });
      await expect(registerExternalRecoveryOffset({
        tenantId: randomUUID(),
        interfaceFamily: 'I06',
        subpath,
      })).rejects.toMatchObject({ code: 'EXTERNAL_RECOVERY_INTERFACE_NOT_IMPLEMENTED' });
    }
  });
});
