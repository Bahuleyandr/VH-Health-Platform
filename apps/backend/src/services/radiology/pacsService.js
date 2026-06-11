// src/services/radiology/pacsService.js
//
// Roadmap B4 — PACS + viewer foundations. The platform side of the
// radiology closed loop:
//
//   * viewer/DICOMweb configuration surface (Orthanc + OHIF, deployed from
//     infra/kubernetes/optional/pacs — owner opts the overlay in)
//   * study linking: when a study lands in PACS (Orthanc Lua/webhook or
//     manual entry), the radiology order is pinned to its
//     StudyInstanceUID and the patient timeline gets an image deep link
//   * DICOM Modality Worklist feed: un-acquired radiology orders exposed
//     in MWL-shaped JSON for the worklist sidecar that renders Orthanc
//     .wl entries (modalities then pull the schedule instead of manual
//     re-typing at the console).

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const STUDY_UID_RE = /^[0-9]+(\.[0-9]+)+$/;

export function getPacsConfig(env = process.env) {
  const dicomwebUrl = (env.PACS_DICOMWEB_URL || '').trim() || null;
  const viewerUrl = (env.PACS_VIEWER_URL || '').trim() || null;
  return {
    enabled: Boolean(dicomwebUrl || viewerUrl),
    dicomweb_url: dicomwebUrl,
    viewer_url: viewerUrl,
    aet: (env.PACS_AET || 'VHHEALTH').trim(),
  };
}

/** OHIF deep link for a study. Pure — exported for unit tests. */
export function buildViewerUrl(studyInstanceUid, env = process.env) {
  const { viewer_url: viewerUrl } = getPacsConfig(env);
  if (!viewerUrl || !studyInstanceUid) return null;
  const base = viewerUrl.replace(/\/+$/, '');
  return `${base}/viewer?StudyInstanceUIDs=${encodeURIComponent(studyInstanceUid)}`;
}

/** DICOM DA (YYYYMMDD) + TM (HHMMSS) formatting. Pure — unit-tested. */
export function toDicomDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

export function toDicomTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
}

/** Map an order + patient row into an MWL-shaped item. Pure — unit-tested. */
export function formatWorklistItem(row, env = process.env) {
  const scheduled = row.scheduled_at || row.created_at || new Date();
  return {
    accession_number: `RAD-${row.id}`,
    order_id: row.id,
    patient: {
      patient_id: row.patient_mrn || String(row.patient_db_id ?? ''),
      patient_uid: row.patient_uid,
      name: row.patient_name || 'UNKNOWN',
      birth_date: row.birthday ? toDicomDate(row.birthday) : null,
      sex: row.gender ? String(row.gender).slice(0, 1).toUpperCase() : 'O',
    },
    modality: String(row.modality || 'OT').toUpperCase(),
    requested_procedure: `${row.modality || ''} ${row.body_part || ''}`.trim(),
    clinical_indication: row.clinical_indication || null,
    priority: row.priority || 'routine',
    scheduled_station_aet: (env.PACS_AET || 'VHHEALTH').trim(),
    scheduled_date: toDicomDate(scheduled),
    scheduled_time: toDicomTime(scheduled),
    referring_physician: row.ordered_by_name || null,
  };
}

/**
 * Pin a PACS study to a radiology order + put the image link on the
 * patient timeline (the roadmap-B4 "images linked from the clinical
 * timeline" requirement).
 */
export async function linkStudy(orderId, { studyInstanceUid, accessionNumber = null } = {}, context = {}) {
  const cleaned = (studyInstanceUid || '').trim();
  if (!STUDY_UID_RE.test(cleaned)) {
    throw AppError.badRequest('study_instance_uid must be a dotted-numeric DICOM UID', 'PACS_BAD_STUDY_UID');
  }
  const tenantId = context.tenantId || context.tenant_id || null;
  const params = [orderId];
  const tenantFilter = tenantId ? ' AND ro.tenant_id = $2::uuid' : '';
  if (tenantId) params.push(tenantId);
  const orders = await prisma.$queryRawUnsafe(
    `SELECT ro.id, ro.tenant_id, ro.patient_uid, ro.modality, ro.body_part, ro.status,
            ro.pacs_study_instance_uid
       FROM radiology_orders ro WHERE ro.id = $1${tenantFilter} LIMIT 1`,
    ...params,
  );
  const order = orders[0];
  if (!order) throw AppError.notFound('Radiology order not found', 'PACS_ORDER_NOT_FOUND');
  if (order.pacs_study_instance_uid && order.pacs_study_instance_uid !== cleaned) {
    throw AppError.conflict(
      `Order already linked to study ${order.pacs_study_instance_uid}`,
      'PACS_ORDER_ALREADY_LINKED',
      { existing_study_instance_uid: order.pacs_study_instance_uid },
    );
  }

  const viewerUrl = buildViewerUrl(cleaned);
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE radiology_orders SET
         pacs_study_instance_uid = $2,
         acquisition_evidence = acquisition_evidence || $3::jsonb,
         updated_at = NOW()
       WHERE id = $1 AND tenant_id = $4::uuid
       RETURNING id, tenant_id, patient_uid, modality, body_part, status, pacs_study_instance_uid`,
      orderId, cleaned,
      JSON.stringify({
        pacs_link: {
          study_instance_uid: cleaned,
          accession_number: accessionNumber || `RAD-${orderId}`,
          linked_by: context.actorUid || null,
          linked_at: new Date().toISOString(),
        },
      }),
      order.tenant_id,
    );
    const row = rows[0];
    await recordCanonicalClinicalEvent({
      tenantId: row.tenant_id,
      patientUid: row.patient_uid,
      eventType: 'imaging.study_linked',
      eventStatus: row.status || 'linked',
      sourceTable: 'radiology_orders',
      sourceId: String(row.id),
      resourceType: 'imaging_study',
      resourceId: cleaned,
      actorUid: context.actorUid || null,
      actorRole: context.actorRole || null,
      summary: `${row.modality} ${row.body_part} images available in PACS`,
      payload: {
        radiology_order_id: row.id,
        study_instance_uid: cleaned,
        accession_number: accessionNumber || `RAD-${orderId}`,
        viewer_url: viewerUrl,
        modality: row.modality,
        body_part: row.body_part,
      },
      tags: ['radiology', 'imaging', 'pacs'],
      timelineIdempotencyKey: `radiology_orders:${row.id}:imaging.study_linked:${cleaned}`,
      auditIdempotencyKey: `radiology_orders:${row.id}:audit:imaging.study_linked:${cleaned}`,
    }, { db: tx });
    return row;
  });

  return { order: updated, viewer_url: viewerUrl };
}

export async function listPatientStudies(patientUid, { tenantId = null } = {}) {
  const params = [patientUid];
  const tenantFilter = tenantId ? ' AND tenant_id = $2::uuid' : '';
  if (tenantId) params.push(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, modality, body_part, clinical_indication, status,
            pacs_study_instance_uid, report_completed_at, report_signed_off_at, created_at
       FROM radiology_orders
      WHERE patient_uid = $1::uuid${tenantFilter} AND pacs_study_instance_uid IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 200`,
    ...params,
  );
  return rows.map((row) => ({
    ...row,
    accession_number: `RAD-${row.id}`,
    viewer_url: buildViewerUrl(row.pacs_study_instance_uid),
  }));
}

/**
 * MWL-shaped feed of un-acquired radiology orders. The Orthanc worklist
 * sidecar polls this and renders .wl entries; modalities then pull their
 * schedule over DICOM MWL.
 */
export async function buildModalityWorklist({ tenantId = null, modality = null, limit = 100 } = {}) {
  const params = [];
  let where = `ro.status IN ('ordered', 'in_progress') AND ro.pacs_study_instance_uid IS NULL`;
  let userTenantJoin = '';
  if (tenantId) {
    params.push(tenantId);
    where += ` AND ro.tenant_id = $${params.length}::uuid`;
    userTenantJoin = ` AND u.tenant_id = $${params.length}::uuid`;
  }
  if (modality) {
    params.push(String(modality).toUpperCase());
    where += ` AND UPPER(ro.modality) = $${params.length}`;
  }
  params.push(Math.min(Number.parseInt(limit, 10) || 100, 500));
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ro.id, ro.patient_uid, ro.modality, ro.body_part, ro.clinical_indication,
            ro.priority, ro.created_at,
            u.id AS patient_db_id, u.name AS patient_name, u.birthday, u.gender,
            (SELECT pi.identifier_value FROM patient_identifiers pi
              WHERE pi.patient_uid = ro.patient_uid AND pi.identifier_type IN ('mrn', 'uhid')
              ORDER BY CASE pi.identifier_type WHEN 'mrn' THEN 0 ELSE 1 END LIMIT 1) AS patient_mrn,
            ub.name AS ordered_by_name
       FROM radiology_orders ro
       LEFT JOIN users u ON u.uid = ro.patient_uid${userTenantJoin}
       LEFT JOIN users ub ON ub.uid = ro.ordered_by
      WHERE ${where}
      ORDER BY CASE ro.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END, ro.created_at ASC
      LIMIT $${params.length}::int`,
    ...params,
  );
  return rows.map((row) => formatWorklistItem(row));
}

export default {
  getPacsConfig,
  buildViewerUrl,
  toDicomDate,
  toDicomTime,
  formatWorklistItem,
  linkStudy,
  listPatientStudies,
  buildModalityWorklist,
};
