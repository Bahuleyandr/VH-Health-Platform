function iso(value, dateOnly = false) {
  if (value == null) return null;
  const rendered = new Date(value).toISOString();
  return dateOnly ? rendered.slice(0, 10) : rendered;
}

export async function recordSalaryRevisionActivatedTx(tx, {
  tenantId,
  revisionId,
  staffUid,
  sourceType,
  sourceId,
  effectiveOn,
  appliedAt,
  termsManifestSha256,
  hrSignatureSha256,
  adminSignatureSha256,
}) {
  const effects = await tx.$queryRawUnsafe(
    `SELECT (
              SELECT payable.id
                FROM salary_revision_payables payable
               WHERE payable.tenant_id = $1::uuid
                 AND payable.revision_id = $2::int
               LIMIT 1
            ) AS payable_id,
            (
              SELECT work.id
                FROM salary_revision_arrears_work_items work
               WHERE work.tenant_id = $1::uuid
                 AND work.revision_id = $2::int
               LIMIT 1
            ) AS arrears_work_item_id`,
    tenantId,
    revisionId,
  );
  const payload = {
    revision_id: Number(revisionId),
    staff_uid: staffUid,
    effective_on: iso(effectiveOn, true),
    applied_at: iso(appliedAt),
    source_type: sourceType,
    source_id: String(sourceId),
    payable_id: effects[0]?.payable_id == null ? null : String(effects[0].payable_id),
    arrears_work_item_id: effects[0]?.arrears_work_item_id == null
      ? null
      : String(effects[0].arrears_work_item_id),
  };
  await tx.$queryRawUnsafe(
    `INSERT INTO salary_revision_activation_events (
       tenant_id, revision_id, staff_uid, source_type, source_id,
       effective_on, applied_at, terms_manifest_sha256,
       hr_signature_sha256, admin_signature_sha256,
       payable_id, arrears_work_item_id, payload
     ) VALUES (
       $1::uuid, $2::int, $3::uuid, $4, $5, $6::date, $7::timestamptz,
       $8::char(64), $9::char(64), $10::char(64), $11::bigint, $12::bigint,
       $13::jsonb
     )
     ON CONFLICT (tenant_id, revision_id, event_type) DO NOTHING
     RETURNING id`,
    tenantId,
    revisionId,
    staffUid,
    sourceType,
    String(sourceId),
    effectiveOn,
    appliedAt,
    termsManifestSha256,
    hrSignatureSha256,
    adminSignatureSha256,
    effects[0]?.payable_id ?? null,
    effects[0]?.arrears_work_item_id ?? null,
    JSON.stringify(payload),
  );
  const recorded = await tx.$queryRawUnsafe(
    `SELECT id, source_type, source_id, effective_on, applied_at,
            terms_manifest_sha256, hr_signature_sha256, admin_signature_sha256,
            payable_id, arrears_work_item_id
       FROM salary_revision_activation_events
      WHERE tenant_id = $1::uuid AND revision_id = $2::int
        AND event_type = 'salary_revision_activated'
      FOR SHARE`,
    tenantId,
    revisionId,
  );
  const event = recorded[0];
  if (!event
      || event.source_type !== sourceType
      || event.source_id !== String(sourceId)
      || iso(event.effective_on, true) !== iso(effectiveOn, true)
      || iso(event.applied_at) !== iso(appliedAt)
      || event.terms_manifest_sha256 !== termsManifestSha256
      || event.hr_signature_sha256 !== hrSignatureSha256
      || event.admin_signature_sha256 !== adminSignatureSha256
      || String(event.payable_id ?? '') !== String(effects[0]?.payable_id ?? '')
      || String(event.arrears_work_item_id ?? '')
        !== String(effects[0]?.arrears_work_item_id ?? '')) {
    throw new Error('Salary revision activation event identity is inconsistent');
  }
  return event;
}
