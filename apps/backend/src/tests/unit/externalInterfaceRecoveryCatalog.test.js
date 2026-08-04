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
        lateRelease: 'c5_2_receipt_backed_per_message_safety_critical',
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
        lateRelease: 'c5_2_receipt_backed_per_message_safety_critical',
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
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I18' }))
      .toMatchObject({
        id: 'I18',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'outbound',
        cursorKind: 'event_outbox_id_positive_ack',
        cursorEvidence: 'contiguous_positive_subscriber_acknowledgement_only',
        facilityScope: 'tenant',
        partitionKind: 'tenant_subscription',
        duplicateKeyKind: 'tenant_subscription_source_identity_payload_sha256',
        transportEvidence: 'http_2xx_only',
        acknowledgementPolicy: 'per_subscription_owner_contract',
        downstreamEffectClassification: 'owner_input_per_subscription',
        lateRelease: 'blocked_while_unclassified_and_owner_directed_only',
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
        lateRelease: 'c5_2_receipt_backed_per_message_routine_non_payment_only',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I23' }))
      .toMatchObject({
        id: 'I23',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'inbound',
        cursorKind: 'opaque_page_token_revision',
        cursorEvidence: 'complete_provider_page_only',
        facilityScope: 'tenant',
        partitionKind: 'stable_canonical_query',
        duplicateKeyKind: 'tenant_sync_run_page_token_sha256_page_sha256',
        pageAtomicity: 'catalog_upserts_and_page_completion_one_transaction',
        statusSemantics: 'completed_and_upsert_coverage_are_not_hwm',
      });
    expect(resolveExternalInterfaceDisposition({ interfaceFamily: 'I25' }))
      .toMatchObject({
        id: 'I25',
        disposition: 'hwm_required',
        defaultEffectDisposition: 'late_pending_only',
        implemented: true,
        direction: 'outbound',
        cursorKind: 'per_target_positive_ack',
        cursorEvidence: 'positive_acknowledgement_attempt_lineage_only',
        facilityScope: 'tenant',
        partitionKind: 'tenant_source_target',
        duplicateKeyKind: 'event_target_attempt_payload_sha256',
        captureCursorSemantics: 'capture_into_event_ledger_not_delivery',
        deliveryTruth: 'per_target_attempts_never_shared_export_status',
        captureScheduling: 'owner_activation_required_no_automatic_caller',
        leaseSemantics: 'expiring_fenced_attempt_claim_with_reaper',
        lateRelease: 'owner_directed_pending_review_only',
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
