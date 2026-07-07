import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { PATHOLOGIST_SIGN_ROLES } from '../../utils/roleHelpers.js';

const STANDARD_TTI_MARKERS = ['hiv', 'hbsag', 'hcv', 'syphilis', 'malaria'];
const VALID_TTI_RESULTS = ['not_tested', 'non_reactive', 'reactive', 'indeterminate'];
const VALID_COMPONENTS = ['whole_blood', 'prbc', 'ffp', 'platelets', 'cryoprecipitate'];
const REGISTER_TYPES = ['donor', 'collection', 'tti', 'component_preparation', 'deferral', 'discard'];
const COMPONENT_EXPIRY_DAYS = Object.freeze({
  whole_blood: 35,
  prbc: 42,
  ffp: 365,
  platelets: 5,
  cryoprecipitate: 365,
});

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for donor processing operations', 'DONOR_PROCESSING_TENANT_REQUIRED');
  }
  return tenantId;
}

function requireActor(context = {}) {
  if (!context.actorUid) {
    throw AppError.unauthorized('Actor identity is required');
  }
}

function requirePathologistSigner(context = {}) {
  requireActor(context);
  if (!PATHOLOGIST_SIGN_ROLES.includes(context.actorRole)) {
    throw AppError.forbidden('TTI approval requires a pathologist or lab signer role', 'TTI_SIGNER_ROLE_REQUIRED', {
      allowed_roles: PATHOLOGIST_SIGN_ROLES,
    });
  }
}

function cleanText(value, max = 1000) {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function asObject(value, fieldName) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${fieldName} must be an object`, 'DONOR_PROCESSING_BAD_JSON_FIELD');
  }
  return value;
}

function normalizeDate(value, fieldName) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${fieldName} must be a valid ISO date`, 'DONOR_PROCESSING_BAD_DATE');
  }
  return date.toISOString().slice(0, 10);
}

function normalizeTtiResult(value) {
  const normalized = cleanText(value, 30)?.toLowerCase() || 'not_tested';
  if (!VALID_TTI_RESULTS.includes(normalized)) {
    throw AppError.badRequest(`TTI marker result must be one of ${VALID_TTI_RESULTS.join(', ')}`, 'TTI_BAD_RESULT');
  }
  return normalized;
}

export function evaluateTtiPanel(results = {}) {
  const panel = asObject(results, 'results');
  const normalized = {};
  for (const marker of STANDARD_TTI_MARKERS) {
    normalized[marker] = normalizeTtiResult(panel[marker] ?? panel[`result_${marker}`]);
  }
  const values = Object.values(normalized);
  let overallResult = 'pending';
  let status = 'pending';
  if (values.includes('reactive')) {
    overallResult = 'reactive';
    status = 'approved';
  } else if (values.includes('indeterminate')) {
    overallResult = 'indeterminate';
    status = 'repeat_required';
  } else if (values.every((value) => value === 'non_reactive')) {
    overallResult = 'non_reactive';
    status = 'approved';
  }
  return {
    results: normalized,
    overallResult,
    status,
    reactiveMarkers: STANDARD_TTI_MARKERS.filter((marker) => normalized[marker] === 'reactive'),
    indeterminateMarkers: STANDARD_TTI_MARKERS.filter((marker) => normalized[marker] === 'indeterminate'),
  };
}

export function deriveComponentExpiry(collectedDate, component) {
  const normalizedComponent = String(component || '').toLowerCase();
  if (!VALID_COMPONENTS.includes(normalizedComponent)) {
    throw AppError.badRequest(`component must be one of ${VALID_COMPONENTS.join(', ')}`, 'COMPONENT_BAD_TYPE');
  }
  const base = normalizeDate(collectedDate, 'collected_date');
  if (!base) {
    throw AppError.badRequest('collected_date is required to derive component expiry', 'COMPONENT_COLLECTION_DATE_REQUIRED');
  }
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + COMPONENT_EXPIRY_DAYS[normalizedComponent]);
  return date.toISOString().slice(0, 10);
}

async function recordProcessingAudit(db, {
  tenantId,
  action,
  resource = 'blood_bank_donor_processing',
  resourceId,
  actorUid,
  actorRole,
  metadata = {},
}) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::text, $7::jsonb, $2::uuid, NOW())`,
    tenantId,
    actorUid || null,
    actorRole || null,
    action,
    resource,
    String(resourceId),
    JSON.stringify(metadata),
  );
}

async function loadDonation(db, donationEventId, tenantId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT de.id, de.tenant_id, de.donor_id, de.screening_id, de.donation_code,
            de.donation_barcode, de.collection_kind, de.camp_name, de.camp_location,
            de.volume_ml, de.status, de.tti_status, de.collected_at, de.collected_by,
            d.donor_uid, d.full_name, d.phone, d.blood_group, d.abo_group, d.rh_factor
       FROM donation_events de
       JOIN donors d ON d.id = de.donor_id AND d.tenant_id = de.tenant_id
      WHERE de.id = $1::int AND de.tenant_id = $2::uuid
      LIMIT 1`,
    Number(donationEventId),
    tenantId,
  );
  return rows[0] || null;
}

async function latestTti(db, donationEventId, tenantId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, overall_result, status, approved_at
       FROM tti_tests
      WHERE donation_event_id = $1::int
        AND tenant_id = $2::uuid
      ORDER BY repeat_sequence DESC, id DESC
      LIMIT 1`,
    Number(donationEventId),
    tenantId,
  );
  return rows[0] || null;
}

function componentPlan(data, donation) {
  const supplied = Array.isArray(data.components) ? data.components : null;
  const plan = supplied?.length ? supplied : [
    { component: 'prbc', volume_ml: Math.round(Number(donation.volume_ml || 450) * 0.55) },
    { component: 'ffp', volume_ml: Math.round(Number(donation.volume_ml || 450) * 0.30) },
    { component: 'platelets', volume_ml: Math.max(40, Math.round(Number(donation.volume_ml || 450) * 0.10)) },
  ];
  return plan.map((item, index) => {
    const component = cleanText(item.component, 30)?.toLowerCase();
    if (!VALID_COMPONENTS.includes(component) || component === 'whole_blood') {
      throw AppError.badRequest('prepared components must be prbc, ffp, platelets, or cryoprecipitate', 'COMPONENT_BAD_TYPE');
    }
    const expiryDate = normalizeDate(item.expiry_date || item.expiryDate, 'expiry_date')
      || deriveComponentExpiry(donation.collected_at, component);
    return {
      component,
      volumeMl: item.volume_ml ?? item.volumeMl ?? null,
      unitNumber: cleanText(item.unit_number || item.unitNumber, 80)
        || `${donation.donation_code}-${component.toUpperCase()}-${index + 1}`,
      expiryDate,
    };
  });
}

function ttiStatusFromResult(overallResult) {
  if (overallResult === 'non_reactive') return 'non_reactive';
  if (overallResult === 'reactive') return 'reactive';
  if (overallResult === 'indeterminate') return 'repeat_required';
  return 'pending';
}

class DonorProcessingService {
  async recordTtiTest(donationEventId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    requirePathologistSigner(context);
    const donation = await loadDonation(prisma, donationEventId, tenantId);
    if (!donation) throw AppError.notFound('Donation event not found', 'DONATION_EVENT_NOT_FOUND');

    const panel = evaluateTtiPanel(data.results || data);
    const repeatParentId = data.repeat_parent_id ?? data.repeatParentId ?? null;

    return setTenantTx(tenantId, async (tx) => {
      let repeatSequence = 1;
      if (repeatParentId) {
        const parentRows = await tx.$queryRawUnsafe(
          `SELECT repeat_sequence
             FROM tti_tests
            WHERE id = $1::int AND tenant_id = $2::uuid AND donation_event_id = $3::int
            LIMIT 1`,
          Number(repeatParentId),
          tenantId,
          Number(donationEventId),
        );
        if (!parentRows.length) throw AppError.notFound('Repeat parent TTI test not found', 'TTI_REPEAT_PARENT_NOT_FOUND');
        repeatSequence = Number(parentRows[0].repeat_sequence) + 1;
      } else {
        const maxRows = await tx.$queryRawUnsafe(
          `SELECT COALESCE(MAX(repeat_sequence), 0)::int + 1 AS next_repeat
             FROM tti_tests
            WHERE tenant_id = $1::uuid AND donation_event_id = $2::int`,
          tenantId,
          Number(donationEventId),
        );
        repeatSequence = Number(maxRows[0].next_repeat);
      }

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO tti_tests
           (tenant_id, donation_event_id, donor_id, panel_code, sample_identifier,
            result_hiv, result_hbsag, result_hcv, result_syphilis, result_malaria,
            results, overall_result, status, repeat_parent_id, repeat_sequence,
            tested_by, tested_at, approved_by, approved_by_role, approved_at, notes, metadata)
         VALUES
           ($1::uuid, $2::int, $3::int, $4, $5, $6, $7, $8, $9, $10,
            $11::jsonb, $12, $13, $14::int, $15::int, $16::uuid, $17::timestamptz,
            $18::uuid, $19, NOW(), $20, $21::jsonb)
         RETURNING id, donation_event_id, donor_id, overall_result, status, repeat_sequence,
                   result_hiv, result_hbsag, result_hcv, result_syphilis, result_malaria,
                   approved_by, approved_by_role, approved_at, created_at`,
        tenantId,
        Number(donationEventId),
        Number(donation.donor_id),
        cleanText(data.panel_code || data.panelCode, 40) || 'standard_tti',
        cleanText(data.sample_identifier || data.sampleIdentifier, 80),
        panel.results.hiv,
        panel.results.hbsag,
        panel.results.hcv,
        panel.results.syphilis,
        panel.results.malaria,
        JSON.stringify(panel.results),
        panel.overallResult,
        panel.status,
        repeatParentId == null ? null : Number(repeatParentId),
        repeatSequence,
        data.tested_by || data.testedBy || context.actorUid || null,
        data.tested_at || data.testedAt || new Date().toISOString(),
        context.actorUid,
        context.actorRole,
        cleanText(data.notes, 2000),
        JSON.stringify({
          reactive_markers: panel.reactiveMarkers,
          indeterminate_markers: panel.indeterminateMarkers,
          ...asObject(data.metadata, 'metadata'),
        }),
      );
      const test = rows[0];

      await tx.$executeRawUnsafe(
        `UPDATE donation_events
            SET tti_status = $3,
                last_tti_test_id = $4::int,
                updated_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(donationEventId),
        tenantId,
        ttiStatusFromResult(panel.overallResult),
        Number(test.id),
      );

      if (panel.overallResult === 'non_reactive') {
        await tx.$executeRawUnsafe(
          `UPDATE blood_units
              SET status = 'available',
                  quarantine_reason = NULL,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND donation_event_id = $2::int
              AND status = 'quarantined'
              AND quarantine_reason = 'TTI pending'`,
          tenantId,
          Number(donationEventId),
        );
      }

      if (panel.overallResult === 'reactive') {
        await this.applyReactiveCascade(tx, {
          tenantId,
          donation,
          test,
          panel,
          actorUid: context.actorUid,
          actorRole: context.actorRole,
        });
      }

      await recordProcessingAudit(tx, {
        tenantId,
        action: `BLOOD_DONATION_TTI_${panel.overallResult.toUpperCase()}`,
        resource: 'tti_tests',
        resourceId: test.id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: {
          donation_event_id: Number(donationEventId),
          donor_id: Number(donation.donor_id),
          overall_result: panel.overallResult,
          status: panel.status,
          reactive_markers: panel.reactiveMarkers,
        },
      });

      logger.info('Blood donation TTI test recorded', {
        tenantId,
        donationEventId,
        ttiTestId: test.id,
        overallResult: panel.overallResult,
      });
      return {
        tti_test: test,
        cascade: panel.overallResult === 'reactive'
          ? { donor_deferred: true, units_quarantined: true, reactive_markers: panel.reactiveMarkers }
          : { donor_deferred: false, units_quarantined: false },
      };
    });
  }

  async applyReactiveCascade(tx, { tenantId, donation, test, panel, actorUid, actorRole }) {
    const reasonText = `Reactive TTI screen: ${panel.reactiveMarkers.join(', ')}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO donor_deferrals
         (tenant_id, donor_id, reason_code, reason_text, permanent, source, created_by, metadata)
       VALUES ($1::uuid, $2::int, 'TTI_REACTIVE', $3, true, 'tti', $4::uuid, $5::jsonb)`,
      tenantId,
      Number(donation.donor_id),
      reasonText,
      actorUid || null,
      JSON.stringify({ tti_test_id: Number(test.id), reactive_markers: panel.reactiveMarkers }),
    );
    await tx.$executeRawUnsafe(
      `UPDATE donors
          SET status = 'deferred_permanent',
              eligibility_status = 'deferred_permanent',
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(donation.donor_id),
      tenantId,
    );

    const unitRows = await tx.$queryRawUnsafe(
      `UPDATE blood_units
          SET status = 'quarantined',
              quarantined_at = NOW(),
              quarantine_reason = $3,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND donation_event_id = $2::int
          AND status NOT IN ('transfused', 'discarded')
        RETURNING id, donor_id, donation_event_id`,
      tenantId,
      Number(donation.id),
      reasonText,
    );

    for (const unit of unitRows) {
      await tx.$executeRawUnsafe(
        `INSERT INTO blood_unit_discard_events
           (tenant_id, unit_id, donor_id, donation_event_id, tti_test_id, event_type,
            reason_code, reason_text, reversible, performed_by, performed_by_role, metadata)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, $5::int, 'quarantined',
                 'TTI_REACTIVE', $6, true, $7::uuid, $8, $9::jsonb)`,
        tenantId,
        Number(unit.id),
        unit.donor_id == null ? Number(donation.donor_id) : Number(unit.donor_id),
        Number(donation.id),
        Number(test.id),
        reasonText,
        actorUid || null,
        actorRole || null,
        JSON.stringify({ cascade: 'tti_reactive', reactive_markers: panel.reactiveMarkers }),
      );
    }
  }

  async prepareComponents(donationEventId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    requireActor(context);
    const donation = await loadDonation(prisma, donationEventId, tenantId);
    if (!donation) throw AppError.notFound('Donation event not found', 'DONATION_EVENT_NOT_FOUND');
    const tti = await latestTti(prisma, donationEventId, tenantId);
    if (tti?.overall_result === 'reactive') {
      throw AppError.conflict('Reactive TTI donations cannot be prepared into transfusable components', 'COMPONENT_TTI_REACTIVE');
    }

    const children = componentPlan(data, donation);
    const preparationCode = cleanText(data.preparation_code || data.preparationCode, 80)
      || `PREP-${donation.donation_code}-${Date.now()}`;
    const collectedDate = normalizeDate(data.collected_date || data.collectedDate, 'collected_date')
      || new Date(donation.collected_at).toISOString().slice(0, 10);
    const ttiCleared = tti?.overall_result === 'non_reactive' && tti?.status === 'approved';
    const childStatus = ttiCleared ? 'available' : 'quarantined';
    const quarantineReason = ttiCleared ? null : 'TTI pending';

    return setTenantTx(tenantId, async (tx) => {
      const parentNumber = cleanText(data.parent_unit_number || data.parentUnitNumber, 80)
        || `${donation.donation_code}-WB`;
      const parentRows = await tx.$queryRawUnsafe(
        `INSERT INTO blood_units
           (tenant_id, unit_number, blood_group, component, status, volume_ml,
            collected_date, expiry_date, donor_ref, donor_id, donation_event_id,
            registered_by, prepared_at, prepared_by, metadata)
         VALUES
           ($1::uuid, $2, $3, 'whole_blood', 'separated', $4::int, $5::date, $6::date,
            $7, $8::int, $9::int, $10::uuid, NOW(), $10::uuid, $11::jsonb)
         ON CONFLICT (tenant_id, unit_number) DO UPDATE SET
           status = 'separated',
           donor_id = EXCLUDED.donor_id,
           donation_event_id = EXCLUDED.donation_event_id,
           updated_at = NOW()
         RETURNING id, unit_number, blood_group, component, status`,
        tenantId,
        parentNumber,
        donation.blood_group,
        donation.volume_ml,
        collectedDate,
        deriveComponentExpiry(collectedDate, 'whole_blood'),
        String(donation.donor_uid),
        Number(donation.donor_id),
        Number(donationEventId),
        context.actorUid || null,
        JSON.stringify({ source: 'component_preparation_parent' }),
      );
      const parent = parentRows[0];

      const prepRows = await tx.$queryRawUnsafe(
        `INSERT INTO component_preparations
           (tenant_id, donation_event_id, donor_id, parent_unit_id, preparation_code,
            method, prepared_units, prepared_by, notes, metadata)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, $5, $6, $7::jsonb, $8::uuid, $9, $10::jsonb)
         RETURNING id, donation_event_id, donor_id, parent_unit_id, preparation_code,
                   method, status, prepared_at, prepared_by`,
        tenantId,
        Number(donationEventId),
        Number(donation.donor_id),
        Number(parent.id),
        preparationCode,
        cleanText(data.method, 40) || 'manual',
        JSON.stringify(children),
        context.actorUid || null,
        cleanText(data.notes, 2000),
        JSON.stringify({ tti_status: tti?.overall_result || 'pending', ...asObject(data.metadata, 'metadata') }),
      );
      const preparation = prepRows[0];
      const units = [];
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        const unitRows = await tx.$queryRawUnsafe(
          `INSERT INTO blood_units
             (tenant_id, unit_number, blood_group, component, status, volume_ml, collected_date,
              expiry_date, donor_ref, donor_id, donation_event_id, parent_unit_id,
              component_preparation_id, component_sequence, registered_by, prepared_at, prepared_by,
              quarantined_at, quarantine_reason, metadata)
           VALUES
             ($1::uuid, $2, $3, $4, $5::text, $6::int, $7::date, $8::date, $9, $10::int,
              $11::int, $12::int, $13::int, $14::int, $15::uuid, NOW(), $15::uuid,
              CASE WHEN $5::text = 'quarantined' THEN NOW() ELSE NULL END, $16, $17::jsonb)
           ON CONFLICT (tenant_id, unit_number) DO UPDATE SET
             status = EXCLUDED.status,
             component_preparation_id = EXCLUDED.component_preparation_id,
             parent_unit_id = EXCLUDED.parent_unit_id,
             donor_id = EXCLUDED.donor_id,
             donation_event_id = EXCLUDED.donation_event_id,
             quarantine_reason = EXCLUDED.quarantine_reason,
             updated_at = NOW()
           RETURNING id, unit_number, blood_group, component, status, expiry_date,
                     donor_id, donation_event_id, parent_unit_id, component_preparation_id`,
          tenantId,
          child.unitNumber,
          donation.blood_group,
          child.component,
          childStatus,
          child.volumeMl == null ? null : Number(child.volumeMl),
          collectedDate,
          child.expiryDate,
          String(donation.donor_uid),
          Number(donation.donor_id),
          Number(donationEventId),
          Number(parent.id),
          Number(preparation.id),
          index + 1,
          context.actorUid || null,
          quarantineReason,
          JSON.stringify({ source: 'component_preparation_child', tti_cleared: ttiCleared }),
        );
        units.push(unitRows[0]);
      }
      await tx.$executeRawUnsafe(
        `UPDATE component_preparations
            SET prepared_units = $3::jsonb,
                updated_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(preparation.id),
        tenantId,
        JSON.stringify(units.map((unit) => ({
          id: unit.id,
          unit_number: unit.unit_number,
          component: unit.component,
          status: unit.status,
          expiry_date: unit.expiry_date,
        }))),
      );
      await recordProcessingAudit(tx, {
        tenantId,
        action: 'BLOOD_COMPONENTS_PREPARED',
        resource: 'component_preparations',
        resourceId: preparation.id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: {
          donation_event_id: Number(donationEventId),
          donor_id: Number(donation.donor_id),
          unit_ids: units.map((unit) => Number(unit.id)),
          tti_cleared: ttiCleared,
        },
      });
      return { preparation: { ...preparation, prepared_units: units }, parent_unit: parent, units };
    });
  }

  async getTraceability({ unitId = null, unitNumber = null } = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    if (!unitId && !unitNumber) {
      throw AppError.badRequest('unit_id or unit_number is required', 'TRACEABILITY_UNIT_REQUIRED');
    }
    const params = [tenantId];
    const condition = unitId
      ? `bu.id = $${params.push(Number(unitId))}::int`
      : `bu.unit_number = $${params.push(String(unitNumber).trim().toUpperCase())}`;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT bu.id, bu.unit_number, bu.blood_group, bu.component, bu.status, bu.expiry_date,
              bu.donor_id, bu.donation_event_id, bu.parent_unit_id, bu.component_preparation_id,
              bu.request_id, bu.quarantine_reason, bu.discard_confirmed_at,
              d.donor_uid, d.full_name AS donor_name, d.phone AS donor_phone,
              de.donation_code, de.donation_barcode, de.collected_at,
              br.id AS transfusion_request_id, br.patient_uid, br.status AS transfusion_status
         FROM blood_units bu
         LEFT JOIN donors d ON d.id = bu.donor_id AND d.tenant_id = bu.tenant_id
         LEFT JOIN donation_events de ON de.id = bu.donation_event_id AND de.tenant_id = bu.tenant_id
         LEFT JOIN blood_requests br ON br.id = bu.request_id AND br.tenant_id = bu.tenant_id
        WHERE bu.tenant_id = $1::uuid AND ${condition}
        LIMIT 1`,
      ...params,
    );
    const unit = rows[0];
    if (!unit) throw AppError.notFound('Blood unit not found', 'BLOOD_UNIT_NOT_FOUND');

    const siblings = await prisma.$queryRawUnsafe(
      `SELECT id, unit_number, blood_group, component, status, expiry_date,
              request_id, quarantine_reason, discard_confirmed_at
         FROM blood_units
        WHERE tenant_id = $1::uuid
          AND id <> $2::int
          AND (
            ($3::int IS NOT NULL AND donation_event_id = $3::int)
            OR ($4::int IS NOT NULL AND parent_unit_id = $4::int)
            OR ($5::int IS NOT NULL AND component_preparation_id = $5::int)
          )
        ORDER BY component_sequence NULLS LAST, id ASC`,
      tenantId,
      Number(unit.id),
      unit.donation_event_id == null ? null : Number(unit.donation_event_id),
      unit.parent_unit_id == null ? null : Number(unit.parent_unit_id),
      unit.component_preparation_id == null ? null : Number(unit.component_preparation_id),
    );
    const ttiTests = unit.donation_event_id == null ? [] : await prisma.$queryRawUnsafe(
      `SELECT id, overall_result, status, result_hiv, result_hbsag, result_hcv,
              result_syphilis, result_malaria, approved_by_role, approved_at
         FROM tti_tests
        WHERE tenant_id = $1::uuid AND donation_event_id = $2::int
        ORDER BY repeat_sequence DESC, id DESC`,
      tenantId,
      Number(unit.donation_event_id),
    );
    const discardEvents = await prisma.$queryRawUnsafe(
      `SELECT id, event_type, reason_code, reason_text, reversible, performed_at
         FROM blood_unit_discard_events
        WHERE tenant_id = $1::uuid AND unit_id = $2::int
        ORDER BY performed_at DESC`,
      tenantId,
      Number(unit.id),
    );
    return {
      unit,
      donor: unit.donor_id ? {
        id: unit.donor_id,
        donor_uid: unit.donor_uid,
        full_name: unit.donor_name,
        phone: unit.donor_phone,
      } : null,
      donation: unit.donation_event_id ? {
        id: unit.donation_event_id,
        donation_code: unit.donation_code,
        donation_barcode: unit.donation_barcode,
        collected_at: unit.collected_at,
      } : null,
      transfusion: unit.transfusion_request_id ? {
        request_id: unit.transfusion_request_id,
        patient_uid: unit.patient_uid,
        status: unit.transfusion_status,
      } : null,
      siblings,
      tti_tests: ttiTests,
      discard_events: discardEvents,
    };
  }

  async confirmDiscard(unitId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    requireActor(context);
    const reasonText = cleanText(data.reason_text || data.reason || data.reasonText, 1000);
    if (!reasonText || reasonText.length < 8) {
      throw AppError.badRequest('discard reason is required', 'DISCARD_REASON_REQUIRED');
    }
    return setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE blood_units
            SET status = 'discarded',
                discard_confirmed_at = NOW(),
                discard_confirmed_by = $3::uuid,
                updated_at = NOW()
          WHERE id = $1::int
            AND tenant_id = $2::uuid
            AND status = 'quarantined'
          RETURNING id, unit_number, donor_id, donation_event_id, status, discard_confirmed_at`,
        Number(unitId),
        tenantId,
        context.actorUid,
      );
      if (!rows.length) {
        throw AppError.conflict('Only quarantined units can be confirmed discarded', 'DISCARD_UNIT_NOT_QUARANTINED');
      }
      const unit = rows[0];
      const eventRows = await tx.$queryRawUnsafe(
        `INSERT INTO blood_unit_discard_events
           (tenant_id, unit_id, donor_id, donation_event_id, event_type, reason_code,
            reason_text, reversible, performed_by, performed_by_role, metadata)
         VALUES ($1::uuid, $2::int, $3::int, $4::int, 'discard_confirmed', $5, $6,
                 false, $7::uuid, $8, $9::jsonb)
         RETURNING id, unit_id, event_type, reason_code, reason_text, performed_at`,
        tenantId,
        Number(unit.id),
        unit.donor_id == null ? null : Number(unit.donor_id),
        unit.donation_event_id == null ? null : Number(unit.donation_event_id),
        cleanText(data.reason_code || data.reasonCode, 80) || 'HUMAN_CONFIRMED_DISCARD',
        reasonText,
        context.actorUid,
        context.actorRole || null,
        JSON.stringify(asObject(data.metadata, 'metadata')),
      );
      await recordProcessingAudit(tx, {
        tenantId,
        action: 'BLOOD_UNIT_DISCARD_CONFIRMED',
        resource: 'blood_units',
        resourceId: unit.id,
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: { reason: reasonText, discard_event_id: Number(eventRows[0].id) },
      });
      return { unit, discard_event: eventRows[0] };
    });
  }

  async createDonorCamp(data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    requireActor(context);
    const name = cleanText(data.name, 160);
    if (!name) throw AppError.badRequest('name is required', 'DONOR_CAMP_NAME_REQUIRED');
    const campCode = cleanText(data.camp_code || data.campCode, 80)
      || `CAMP-${Date.now()}`;
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO donor_camps
         (tenant_id, camp_code, name, organizer, location, scheduled_date, status,
          expected_donors, contact_name, contact_phone, notes, created_by, metadata)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::date, $7, $8::int, $9, $10, $11, $12::uuid, $13::jsonb)
       RETURNING id, camp_code, name, organizer, location, scheduled_date, status,
                 expected_donors, collected_units, contact_name, contact_phone, notes, created_at`,
      tenantId,
      campCode,
      name,
      cleanText(data.organizer, 160),
      cleanText(data.location, 2000),
      normalizeDate(data.scheduled_date || data.scheduledDate, 'scheduled_date'),
      cleanText(data.status, 20) || 'planned',
      data.expected_donors ?? data.expectedDonors ?? null,
      cleanText(data.contact_name || data.contactName, 160),
      cleanText(data.contact_phone || data.contactPhone, 30),
      cleanText(data.notes, 2000),
      context.actorUid,
      JSON.stringify(asObject(data.metadata, 'metadata')),
    );
    return rows[0];
  }

  async listDonorCamps(filters = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const status = cleanText(filters.status, 20);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, camp_code, name, organizer, location, scheduled_date, status,
              expected_donors, collected_units, contact_name, contact_phone, notes, created_at
         FROM donor_camps
        WHERE tenant_id = $1::uuid
          AND ($2::text IS NULL OR status = $2::text)
        ORDER BY scheduled_date DESC NULLS LAST, created_at DESC
        LIMIT 200`,
      tenantId,
      status,
    );
    return { camps: rows, count: rows.length };
  }

  async buildRegisterRows(registerType, filters = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const type = String(registerType || '').replaceAll('-', '_');
    if (!REGISTER_TYPES.includes(type)) {
      throw AppError.badRequest(`register_type must be one of ${REGISTER_TYPES.join(', ')}`, 'REGISTER_BAD_TYPE');
    }
    const dateFrom = normalizeDate(filters.from || filters.date_from || filters.dateFrom, 'from');
    const dateTo = normalizeDate(filters.to || filters.date_to || filters.dateTo, 'to');
    const windowSql = (column, params) => {
      const conditions = [];
      if (dateFrom) {
        params.push(dateFrom);
        conditions.push(`${column} >= $${params.length}::date`);
      }
      if (dateTo) {
        params.push(dateTo);
        conditions.push(`${column} < ($${params.length}::date + INTERVAL '1 day')`);
      }
      return conditions.length ? ` AND ${conditions.join(' AND ')}` : '';
    };

    const params = [tenantId];
    let sql;
    if (type === 'donor') {
      sql = `SELECT donor_uid, full_name, phone, gender, date_of_birth, blood_group,
                    status, eligibility_status, registered_at
               FROM donors
              WHERE tenant_id = $1::uuid${windowSql('registered_at', params)}
              ORDER BY registered_at DESC LIMIT 500`;
    } else if (type === 'collection') {
      sql = `SELECT de.donation_code, de.donation_barcode, d.full_name, d.phone,
                    d.blood_group, de.collection_kind, de.volume_ml, de.status,
                    de.tti_status, de.collected_at
               FROM donation_events de
               JOIN donors d ON d.id = de.donor_id AND d.tenant_id = de.tenant_id
              WHERE de.tenant_id = $1::uuid${windowSql('de.collected_at', params)}
              ORDER BY de.collected_at DESC LIMIT 500`;
    } else if (type === 'tti') {
      sql = `SELECT de.donation_code, d.full_name, d.blood_group, tt.overall_result,
                    tt.status, tt.result_hiv, tt.result_hbsag, tt.result_hcv,
                    tt.result_syphilis, tt.result_malaria, tt.approved_by_role, tt.approved_at
               FROM tti_tests tt
               JOIN donation_events de ON de.id = tt.donation_event_id AND de.tenant_id = tt.tenant_id
               JOIN donors d ON d.id = tt.donor_id AND d.tenant_id = tt.tenant_id
              WHERE tt.tenant_id = $1::uuid${windowSql('tt.created_at', params)}
              ORDER BY tt.created_at DESC LIMIT 500`;
    } else if (type === 'component_preparation') {
      sql = `SELECT cp.preparation_code, de.donation_code, d.full_name, d.blood_group,
                    cp.method, cp.status, cp.prepared_at, cp.prepared_units
               FROM component_preparations cp
               JOIN donation_events de ON de.id = cp.donation_event_id AND de.tenant_id = cp.tenant_id
               JOIN donors d ON d.id = cp.donor_id AND d.tenant_id = cp.tenant_id
              WHERE cp.tenant_id = $1::uuid${windowSql('cp.prepared_at', params)}
              ORDER BY cp.prepared_at DESC LIMIT 500`;
    } else if (type === 'deferral') {
      sql = `SELECT d.full_name, d.phone, d.blood_group, df.reason_code, df.reason_text,
                    df.permanent, df.deferred_until, df.status, df.source, df.created_at
               FROM donor_deferrals df
               JOIN donors d ON d.id = df.donor_id AND d.tenant_id = df.tenant_id
              WHERE df.tenant_id = $1::uuid${windowSql('df.created_at', params)}
              ORDER BY df.created_at DESC LIMIT 500`;
    } else {
      sql = `SELECT bu.unit_number, bu.blood_group, bu.component, bde.event_type,
                    bde.reason_code, bde.reason_text, bde.reversible, bde.performed_by_role,
                    bde.performed_at
               FROM blood_unit_discard_events bde
               JOIN blood_units bu ON bu.id = bde.unit_id AND bu.tenant_id = bde.tenant_id
              WHERE bde.tenant_id = $1::uuid${windowSql('bde.performed_at', params)}
              ORDER BY bde.performed_at DESC LIMIT 500`;
    }

    const rows = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(sql, ...params), { readOnly: true });
    return {
      register_type: type,
      format_pending: true,
      format_note: 'Authoritative statutory format pending owner-sourced Drugs & Cosmetics/NBTC-NACO register templates.',
      rows,
    };
  }

  async exportRegister(registerType, { format = 'json', ...filters } = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const normalizedFormat = String(format || 'json').toLowerCase();
    if (!['json', 'xlsx', 'pdf'].includes(normalizedFormat)) {
      throw AppError.badRequest('format must be json, xlsx, or pdf', 'REGISTER_BAD_FORMAT');
    }
    const payload = await this.buildRegisterRows(registerType, filters, context);
    await prisma.$executeRawUnsafe(
      `INSERT INTO blood_bank_register_exports
         (tenant_id, register_type, export_format, format_pending, filters,
          row_count, generated_by, generated_by_role, metadata)
       VALUES ($1::uuid, $2, $3, true, $4::jsonb, $5::int, $6::uuid, $7, $8::jsonb)`,
      tenantId,
      payload.register_type,
      normalizedFormat,
      JSON.stringify(filters),
      payload.rows.length,
      context.actorUid || null,
      context.actorRole || null,
      JSON.stringify({ format_note: payload.format_note }),
    );
    if (normalizedFormat === 'json') return payload;
    if (normalizedFormat === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(`${payload.register_type} register`);
      const columns = Object.keys(payload.rows[0] || { note: payload.format_note });
      sheet.columns = columns.map((key) => ({ header: key, key, width: Math.min(Math.max(key.length + 4, 16), 42) }));
      for (const row of payload.rows) sheet.addRow(row);
      sheet.addRow({});
      sheet.addRow({ [columns[0] || 'note']: `FORMAT PENDING: ${payload.format_note}` });
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      return {
        ...payload,
        buffer,
        content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `blood-bank-${payload.register_type}-register.xlsx`,
      };
    }
    const buffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 36, size: 'A4' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.fontSize(16).text(`Blood Bank ${payload.register_type.replaceAll('_', ' ')} Register`, { underline: true });
      doc.moveDown(0.5).fontSize(9).text(`FORMAT PENDING: ${payload.format_note}`);
      doc.moveDown();
      for (const [index, row] of payload.rows.entries()) {
        doc.fontSize(10).text(`${index + 1}. ${JSON.stringify(row)}`);
        if (doc.y > 760) doc.addPage();
      }
      if (!payload.rows.length) doc.text('No rows for the selected window.');
      doc.end();
    });
    return {
      ...payload,
      buffer,
      content_type: 'application/pdf',
      filename: `blood-bank-${payload.register_type}-register.pdf`,
    };
  }
}

export default new DonorProcessingService();
