const HWM = 'hwm_required';
const NOT_APPLICABLE = 'not_applicable_no_replayable_stream';
const MIXED = 'mixed';

const entry = (id, name, disposition, extra = {}) => Object.freeze({
  id,
  name,
  disposition,
  implemented: ['I01', 'I02', 'I09', 'I10', 'I15', 'I17'].includes(id),
  defaultEffectDisposition: disposition === HWM ? 'late_pending_only' : null,
  ...extra,
});

const catalogEntries = [
  entry('I01', 'LIS ORU inbound', HWM, {
    direction: 'inbound',
    cursorKind: 'monotonic_position_and_predecessor',
    facilityScope: 'tenant',
    duplicateKeyKind: 'tenant_sender_msh10',
    partitionKind: 'tenant_trusted_sender',
  }),
  entry('I02', 'ASTM analyzer inbound', HWM, {
    direction: 'inbound',
    cursorKind: 'monotonic_position_and_predecessor',
    facilityScope: 'tenant',
    duplicateKeyKind: 'tenant_analyzer_canonical_astm_sha256',
    partitionKind: 'tenant_analyzer',
  }),
  entry('I03', 'HL7 ADT and ORM inbound', HWM),
  entry('I04', 'HL7 outbound', HWM),
  entry('I05', 'Generic integration-engine streams', HWM),
  entry('I06', 'PACS and DICOM', MIXED, {
    subpaths: Object.freeze({
      study_link: HWM,
      worklist_read: NOT_APPLICABLE,
      metadata_read: NOT_APPLICABLE,
    }),
  }),
  entry('I07', 'External pharmacy connector', NOT_APPLICABLE),
  entry('I08', 'External blood-bank connector', NOT_APPLICABLE),
  entry('I09', 'Device-vitals gateway spool', HWM, {
    direction: 'inbound',
    cursorKind: 'monotonic_position_and_predecessor',
    facilityScope: 'tenant',
    duplicateKeyKind: 'tenant_device_msh10',
    partitionKind: 'tenant_gateway_device',
  }),
  entry('I10', 'Cold-chain sensor stream', HWM, {
    direction: 'inbound',
    cursorKind: 'monotonic_position_and_predecessor',
    facilityScope: 'facility',
    duplicateKeyKind: 'source_reading_id',
    partitionKind: 'facility_unit_sensor',
  }),
  entry('I11', 'OIDC browser and token exchange', NOT_APPLICABLE),
  entry('I12', 'SAML browser and assertion exchange', NOT_APPLICABLE),
  entry('I13', 'SCIM provisioning changes', HWM),
  entry('I14', 'Firebase authentication and attestation', NOT_APPLICABLE),
  entry('I15', 'FHIR and SMART', MIXED, {
    subpaths: Object.freeze({
      fhir_write: HWM,
      smart_oauth: NOT_APPLICABLE,
    }),
    direction: 'inbound',
    cursorKind: 'monotonic_position_and_predecessor',
    facilityScope: 'tenant',
    duplicateKeyKind: 'client_event_or_conditional_identity',
    partitionKind: 'tenant_client_resource',
  }),
  entry('I16', 'ABDM callbacks and transfer work', HWM),
  entry('I17', 'Notification delivery', HWM, {
    direction: 'outbound',
    cursorKind: 'monotonic_position_and_predecessor',
    facilityScope: 'tenant',
    duplicateKeyKind: 'tenant_source_recipient_channel_template_rendered_intent_sha256',
    partitionKind: 'tenant_channel',
  }),
  entry('I18', 'Subscriber webhooks', HWM),
  entry('I19', 'NHCX messages and callbacks', HWM),
  entry('I20', 'Synchronous prior authorization', NOT_APPLICABLE),
  entry('I21', 'Teleconsult real-time media', NOT_APPLICABLE),
  entry('I22', 'WHO ICD lookup', NOT_APPLICABLE),
  entry('I23', 'ClinicalTrials.gov catalog', HWM),
  entry('I24', 'AI provider request-response', NOT_APPLICABLE),
  entry('I25', 'SIEM export', HWM),
  entry('I26', 'Application observability transports', NOT_APPLICABLE),
  entry('I27', 'Object storage and malware scan', NOT_APPLICABLE),
  entry('I28', 'CDS Hooks request-response', NOT_APPLICABLE),
  entry('I29', 'Metabase signed embed', NOT_APPLICABLE),
  entry('I30', 'Payment-link manual distribution', NOT_APPLICABLE),
];

export const EXTERNAL_INTERFACE_RECOVERY_CATALOG = Object.freeze(
  Object.fromEntries(catalogEntries.map((item) => [item.id, item])),
);

export const EXTERNAL_INTERFACE_RECOVERY_FAMILIES = Object.freeze(
  catalogEntries.map((item) => item.id),
);

export function resolveExternalInterfaceDisposition({
  interfaceFamily,
  subpath = null,
} = {}) {
  const family = String(interfaceFamily || '').trim().toUpperCase();
  const selected = EXTERNAL_INTERFACE_RECOVERY_CATALOG[family];
  if (!selected) {
    throw new TypeError('External interface family must be exactly I01 through I30');
  }

  if (selected.disposition !== MIXED) {
    if (subpath !== null && subpath !== undefined && String(subpath).trim() !== '') {
      throw new TypeError(`${family} does not define selectable subpaths`);
    }
    return selected;
  }

  const normalizedSubpath = String(subpath || '').trim().toLowerCase();
  const disposition = selected.subpaths[normalizedSubpath];
  if (!disposition) {
    throw new TypeError(`${family} requires an exact recorded subpath disposition`);
  }
  return Object.freeze({
    ...selected,
    selectedSubpath: normalizedSubpath,
    selectedDisposition: disposition,
    defaultEffectDisposition: disposition === HWM ? 'late_pending_only' : null,
  });
}

export const EXTERNAL_INTERFACE_DISPOSITIONS = Object.freeze({
  HWM,
  NOT_APPLICABLE,
  MIXED,
});
