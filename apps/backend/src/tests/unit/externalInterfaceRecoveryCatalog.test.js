import {
  EXTERNAL_INTERFACE_RECOVERY_CATALOG,
  EXTERNAL_INTERFACE_RECOVERY_FAMILIES,
  resolveExternalInterfaceDisposition,
} from '../../config/externalInterfaceRecoveryCatalog.js';
import {
  EXTERNAL_INTERFACE_RECOVERY_ADAPTER_FAMILIES,
} from '../../services/integrations/externalInterfaceRecoveryService.js';

describe('external interface recovery catalog', () => {
  it('records exactly I01 through I30 once', () => {
    expect(EXTERNAL_INTERFACE_RECOVERY_FAMILIES).toEqual(
      Array.from({ length: 30 }, (_, index) => `I${String(index + 1).padStart(2, '0')}`),
    );
    expect(Object.keys(EXTERNAL_INTERFACE_RECOVERY_CATALOG))
      .toEqual(EXTERNAL_INTERFACE_RECOVERY_FAMILIES);
  });

  it('keeps every implemented adapter declared in the catalog and vice versa', () => {
    const catalogFamilies = Object.values(EXTERNAL_INTERFACE_RECOVERY_CATALOG)
      .filter((item) => item.implemented)
      .map((item) => item.id)
      .sort();
    const adapterFamilies = [...EXTERNAL_INTERFACE_RECOVERY_ADAPTER_FAMILIES].sort();
    expect(new Set(adapterFamilies).size).toBe(adapterFamilies.length);
    expect(catalogFamilies).toEqual(adapterFamilies);
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
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I04' }))
      .toMatchObject({
        id: 'I04',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'outbound',
        cursorKind: 'monotonic_position_and_predecessor',
        facilityScope: 'tenant',
        partitionKind: 'tenant_subscription',
        duplicateKeyKind: 'tenant_subscription_source_event_message_type_payload_sha256',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I05' }))
      .toMatchObject({
        id: 'I05',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        directions: ['inbound', 'outbound'],
        implementedProtocols: expect.arrayContaining(['hl7v2']),
        facilityScope: 'tenant',
        partitionKind: 'tenant_channel_direction_target',
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
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I13' }))
      .toMatchObject({
        id: 'I13',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'inbound',
        cursorKind: 'owner_reconciled_list_diff',
        facilityScope: 'tenant',
        partitionKind: 'tenant_provider_direction',
        duplicateKeyKind: 'tenant_provider_method_resource_payload_sha256',
        providerSequence: 'absent',
        replayAuthority: 'owner_directed_list_diff_only',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I16' }))
      .toMatchObject({
        id: 'I16',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'inbound',
        cursorKind: 'owner_reconciled_provider_transaction',
        facilityScope: 'tenant',
        partitionKind: 'tenant_environment_direction',
        duplicateKeyKind: 'tenant_callback_kind_consent_request_or_transaction',
        providerSequence: 'absent',
        replayGuardRole: 'pre_auth_short_ttl_only',
        replayAuthority: 'owner_directed_disposition_only',
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
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I17' }))
      .toMatchObject({
        id: 'I17',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'outbound',
        cursorKind: 'monotonic_position_and_predecessor',
        facilityScope: 'tenant',
        partitionKind: 'tenant_channel',
        duplicateKeyKind: 'tenant_source_recipient_channel_template_rendered_intent_sha256',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I19' }))
      .toMatchObject({
        id: 'I19',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'outbound',
        cursorKind: 'local_nhcx_message_id',
        facilityScope: 'tenant',
        partitionKind: 'tenant_environment_direction_endpoint',
        duplicateKeyKind: 'tenant_hcx_api_call_id',
        inboundProviderSequence: 'absent',
        inboundRecovery: 'blocked_owner_claim_only',
        inboundIdentityKind: 'correlation_workflow_api_call_and_payload_sha256',
        replayAuthority: 'owner_directed_outbound_only',
        paymentNoticeRecovery: 'manual_only',
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
