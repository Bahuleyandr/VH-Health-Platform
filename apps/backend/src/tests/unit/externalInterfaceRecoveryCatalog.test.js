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

  it('implements only I10 in C6.1-A and keeps its late default explicit', () => {
    expect(
      Object.values(EXTERNAL_INTERFACE_RECOVERY_CATALOG)
        .filter((item) => item.implemented)
        .map((item) => item.id),
    ).toEqual(['I10']);
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'i10' }))
      .toMatchObject({
        id: 'I10',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        facilityScope: 'facility',
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
