import {
  EXTERNAL_INTERFACE_RECOVERY_CATALOG,
  EXTERNAL_INTERFACE_RECOVERY_FAMILIES,
  resolveExternalInterfaceDisposition,
} from '../../config/externalInterfaceRecoveryCatalog.js';

describe('external interface recovery catalog', () => {
  it('records exactly I01 through I30 once', () => {
    expect(EXTERNAL_INTERFACE_RECOVERY_FAMILIES).toEqual(
      Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`),
    );
    expect(Object.keys(EXTERNAL_INTERFACE_RECOVERY_CATALOG))
      .toEqual(EXTERNAL_INTERFACE_RECOVERY_FAMILIES);
  });

  it('adds C6.1-C laboratory families to the landed implementations with explicit scopes', () => {
    expect(
      Object.values(EXTERNAL_INTERFACE_RECOVERY_CATALOG)
        .filter((item) => item.implemented)
        .map((item) => item.id),
    ).toEqual(['I01', 'I02', 'I09', 'I10', 'I15']);
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I01' }))
      .toMatchObject({
        id: 'I01',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        facilityScope: 'tenant',
        duplicateKeyKind: 'tenant_sender_msh10',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I02' }))
      .toMatchObject({
        id: 'I02',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        facilityScope: 'tenant',
        duplicateKeyKind: 'tenant_analyzer_canonical_astm_sha256',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I09' }))
      .toMatchObject({
        id: 'I09',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        facilityScope: 'tenant',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'i10' }))
      .toMatchObject({
        id: 'I10',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        facilityScope: 'facility',
      });
    expect(resolveExternalInterfaceDisposition({
      interfaceFamily: 'I15',
      subpath: 'fhir_write',
    })).toMatchObject({
      id: 'I15',
      selectedDisposition: 'hwm_required',
      defaultEffectDisposition: 'late_pending_only',
      facilityScope: 'tenant',
    });
    expect(resolveExternalInterfaceDisposition({
      interfaceFamily: 'I15',
      subpath: 'smart_oauth',
    })).toMatchObject({
      selectedDisposition: 'not_applicable_no_replayable_stream',
    });
  });

  it('requires exact mixed-subpath selection without fallthrough', () => {
    expect(resolveExternalInterfaceDisposition({
      interfaceFamily: 'I06',
      subpath: 'study_link',
    })).toMatchObject({
      selectedSubpath: 'study_link',
      selectedDisposition: 'hwm_required',
    });
    expect(resolveExternalInterfaceDisposition({
      interfaceFamily: 'I06',
      subpath: 'worklist_read',
    })).toMatchObject({
      selectedDisposition: 'not_applicable_no_replayable_stream',
    });
    expect(() => resolveExternalInterfaceDisposition({ interfaceFamily: 'I06' }))
      .toThrow('requires an exact recorded subpath disposition');
    expect(() => resolveExternalInterfaceDisposition({
      interfaceFamily: 'I06',
      subpath: 'worklist',
    })).toThrow('requires an exact recorded subpath disposition');
    expect(() => resolveExternalInterfaceDisposition({
      interfaceFamily: 'I10',
      subpath: 'study_link',
    })).toThrow('does not define selectable subpaths');
  });

  it('rejects unknown, concatenated, and path-shaped family identifiers', () => {
    for (const interfaceFamily of ['I00', 'I31', 'I10/I17', 'I10:late', '']) {
      expect(() => resolveExternalInterfaceDisposition({ interfaceFamily }))
        .toThrow('exactly I01 through I30');
    }
  });
});
