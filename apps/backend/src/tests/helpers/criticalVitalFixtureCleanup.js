export async function cleanupCriticalVitalFixtures(prisma, tenantId, patientUids) {
  return prisma.$transaction(async (tx) => {
    const deviceLinks = await tx.$executeRawUnsafe(
      `DELETE FROM resuscitation_device_links AS link
        USING resuscitation_events AS event
        WHERE link.resuscitation_event_id = event.id
          AND event.tenant_id = $1::uuid
          AND event.patient_uid = ANY($2::uuid[])
          AND event.trigger_source = 'critical_vital'
          AND event.metadata->>'source' = 'vitalSignMonitor'
          AND link.tenant_id = event.tenant_id
          AND link.patient_uid = event.patient_uid
          AND link.link_kind = 'clinical_alert'
          AND link.evidence->>'source' = 'vitalSignMonitor'`,
      tenantId,
      patientUids,
    );
    // Unexpected clinical children must block deletion, not be swept away.
    const events = await tx.$executeRawUnsafe(
      `DELETE FROM resuscitation_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = ANY($2::uuid[])
          AND trigger_source = 'critical_vital'
          AND metadata->>'source' = 'vitalSignMonitor'`,
      tenantId,
      patientUids,
    );
    return { deviceLinks, events };
  });
}
