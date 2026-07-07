import crypto from 'node:crypto';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';

const VALID_BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const VALID_ABO = ['A', 'B', 'AB', 'O'];
const VALID_RH = ['positive', 'negative'];
const DONOR_RETURNING = `id, donor_uid, full_name, phone, email, gender, date_of_birth,
  age_years, address, government_id_type, government_id_ref, abo_group, rh_factor,
  blood_group, status, eligibility_status, last_screened_at, last_donated_at,
  registered_by, registered_at, updated_at, metadata`;

function requireTenantId(tenantId) {
  if (!tenantId) {
    throw AppError.forbidden('Tenant context is required for donor intake operations', 'DONOR_TENANT_REQUIRED');
  }
  return tenantId;
}

function cleanText(value, max = 1000) {
  if (value == null) return null;
  const cleaned = String(value).trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function asObject(value, fieldName) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${fieldName} must be an object`, 'DONOR_BAD_JSON_FIELD');
  }
  return value;
}

function parseIsoDate(value, fieldName) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    throw AppError.badRequest(`${fieldName} must be a valid ISO date`, 'DONOR_BAD_DATE');
  }
  return date.toISOString().slice(0, 10);
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const today = new Date();
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = today.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && today.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

function datePlusDays(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function birthdayAtAge(dateOfBirth, age) {
  if (!dateOfBirth) return datePlusDays(365);
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  dob.setUTCFullYear(dob.getUTCFullYear() + age);
  return dob.toISOString().slice(0, 10);
}

function normalizeBloodGroup({ bloodGroup, aboGroup, rhFactor } = {}) {
  const group = cleanText(bloodGroup, 5)?.toUpperCase() || null;
  if (group) {
    if (!VALID_BLOOD_GROUPS.includes(group)) {
      throw AppError.badRequest(`blood_group must be one of ${VALID_BLOOD_GROUPS.join(', ')}`, 'DONOR_BAD_BLOOD_GROUP');
    }
    return {
      bloodGroup: group,
      aboGroup: group.replace(/[+-]$/, ''),
      rhFactor: group.endsWith('+') ? 'positive' : 'negative',
    };
  }

  const abo = cleanText(aboGroup, 2)?.toUpperCase() || null;
  const rh = cleanText(rhFactor, 8)?.toLowerCase() || null;
  if ((abo && !VALID_ABO.includes(abo)) || (rh && !VALID_RH.includes(rh))) {
    throw AppError.badRequest('abo_group/rh_factor are invalid', 'DONOR_BAD_ABO_RH');
  }
  return {
    bloodGroup: abo && rh ? `${abo}${rh === 'positive' ? '+' : '-'}` : null,
    aboGroup: abo,
    rhFactor: rh,
  };
}

function boolQuestion(questionnaire, key) {
  return questionnaire[key] === true || questionnaire[key] === 'true' || questionnaire[key] === 'yes';
}

function pushRule(rules, { code, text, days = null, permanent = false, until = null }) {
  rules.push({
    code,
    text,
    permanent,
    until: permanent ? null : (until || datePlusDays(days ?? 30)),
  });
}

export function evaluateDeferralRules({
  dateOfBirth = null,
  ageYears = null,
  questionnaire = {},
  vitals = {},
} = {}) {
  const q = asObject(questionnaire, 'questionnaire');
  const v = asObject(vitals, 'vitals');
  const age = Number.isFinite(Number(ageYears)) ? Number(ageYears) : calculateAge(dateOfBirth);
  const rules = [];

  if (age != null && age < 18) {
    pushRule(rules, {
      code: 'UNDERAGE',
      text: 'Donor is younger than 18 years',
      until: birthdayAtAge(dateOfBirth, 18),
    });
  }
  if (age != null && age > 65) {
    pushRule(rules, {
      code: 'OVER_AGE_LIMIT',
      text: 'Donor is older than 65 years',
      permanent: true,
    });
  }

  const weight = Number(v.weight_kg ?? v.weightKg ?? NaN);
  if (Number.isFinite(weight) && weight < 45) {
    pushRule(rules, { code: 'LOW_WEIGHT', text: 'Weight is below 45 kg', days: 30 });
  }

  const hb = Number(v.hemoglobin_g_dl ?? v.hemoglobinGdl ?? NaN);
  if (Number.isFinite(hb) && hb < 12.5) {
    pushRule(rules, { code: 'LOW_HEMOGLOBIN', text: 'Hemoglobin is below 12.5 g/dL', days: 90 });
  }

  const systolic = Number(v.systolic_bp ?? v.systolicBp ?? NaN);
  const diastolic = Number(v.diastolic_bp ?? v.diastolicBp ?? NaN);
  if ((Number.isFinite(systolic) && (systolic < 90 || systolic > 180))
    || (Number.isFinite(diastolic) && (diastolic > 100))) {
    pushRule(rules, { code: 'BLOOD_PRESSURE_OUT_OF_RANGE', text: 'Blood pressure is outside donation range', days: 7 });
  }

  const temperature = Number(v.temperature_c ?? v.temperatureC ?? NaN);
  if (Number.isFinite(temperature) && temperature >= 37.5) {
    pushRule(rules, { code: 'FEVER', text: 'Temperature suggests current fever', days: 14 });
  }

  if (boolQuestion(q, 'currently_unwell') || boolQuestion(q, 'recent_fever') || boolQuestion(q, 'antibiotics')) {
    pushRule(rules, { code: 'CURRENT_ILLNESS', text: 'Current illness or recent infection reported', days: 14 });
  }
  if (boolQuestion(q, 'tattoo_recent') || boolQuestion(q, 'piercing_recent')) {
    pushRule(rules, { code: 'RECENT_TATTOO_PIERCING', text: 'Recent tattoo or piercing reported', days: 180 });
  }
  if (boolQuestion(q, 'pregnant') || boolQuestion(q, 'recent_delivery')) {
    pushRule(rules, { code: 'PREGNANCY_RECENT_DELIVERY', text: 'Pregnancy or recent delivery reported', days: 365 });
  }
  if (boolQuestion(q, 'high_risk_exposure')) {
    pushRule(rules, { code: 'HIGH_RISK_EXPOSURE', text: 'High-risk exposure reported', days: 365 });
  }
  if (boolQuestion(q, 'previous_positive_tti')) {
    pushRule(rules, { code: 'PREVIOUS_POSITIVE_TTI', text: 'Prior transfusion-transmissible infection reported', permanent: true });
  }

  if (!rules.length) {
    return {
      verdict: 'eligible',
      reasons: [],
      reasonText: 'Eligible for donation',
      deferralUntil: null,
      permanent: false,
      primaryReasonCode: null,
    };
  }

  const permanent = rules.some((rule) => rule.permanent);
  const activeUntil = rules
    .filter((rule) => rule.until)
    .map((rule) => rule.until)
    .sort()
    .at(-1) || null;
  return {
    verdict: permanent ? 'deferred_permanent' : 'deferred_temporary',
    reasons: rules,
    reasonText: rules.map((rule) => rule.text).join('; '),
    deferralUntil: permanent ? null : activeUntil,
    permanent,
    primaryReasonCode: rules[0].code,
  };
}

async function recordDonorAudit(db, {
  tenantId,
  donorId,
  action,
  actorUid,
  actorRole,
  metadata = {},
}) {
  await db.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, role, action, resource, resource_id, metadata, actor_uid, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'donors', $5::text, $6::jsonb, $2::uuid, NOW())`,
    tenantId,
    actorUid || null,
    actorRole || null,
    action,
    String(donorId),
    JSON.stringify(metadata),
  );
}

async function loadDonor(db, donorId, tenantId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${DONOR_RETURNING}
       FROM donors
      WHERE id = $1::int AND tenant_id = $2::uuid
      LIMIT 1`,
    Number(donorId),
    tenantId,
  );
  return rows[0] || null;
}

async function assertNoActiveDeferral(db, donorId, tenantId) {
  const rows = await db.$queryRawUnsafe(
    `SELECT id, reason_code, reason_text, permanent, deferred_until
       FROM donor_deferrals
      WHERE donor_id = $1::int
        AND tenant_id = $2::uuid
        AND status = 'active'
        AND (permanent = true OR deferred_until IS NULL OR deferred_until >= CURRENT_DATE)
      ORDER BY created_at DESC
      LIMIT 1`,
    Number(donorId),
    tenantId,
  );
  if (rows.length) {
    throw AppError.conflict('Donor has an active deferral', 'DONOR_ACTIVE_DEFERRAL', {
      deferral: rows[0],
    });
  }
}

function donationBarcode(tenantId, donorId) {
  const tenantPrefix = String(tenantId).slice(0, 8).toUpperCase();
  return `DN-${tenantPrefix}-${donorId}-${Date.now()}`;
}

class DonorIntakeService {
  async registerDonor(data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const fullName = cleanText(data.full_name || data.fullName, 160);
    if (!fullName) {
      throw AppError.badRequest('full_name is required', 'DONOR_NAME_REQUIRED');
    }

    const dateOfBirth = parseIsoDate(data.date_of_birth || data.dateOfBirth, 'date_of_birth');
    const ageYears = data.age_years ?? data.ageYears ?? calculateAge(dateOfBirth);
    const phone = normalizePhone(data.phone);
    const governmentIdType = cleanText(data.government_id_type || data.governmentIdType, 40);
    const governmentIdRef = cleanText(data.government_id_ref || data.governmentIdRef, 120);
    const { bloodGroup, aboGroup, rhFactor } = normalizeBloodGroup({
      bloodGroup: data.blood_group || data.bloodGroup,
      aboGroup: data.abo_group || data.aboGroup,
      rhFactor: data.rh_factor || data.rhFactor,
    });

    const duplicateMatches = await prisma.$queryRawUnsafe(
      `SELECT id, donor_uid, full_name, phone, date_of_birth, government_id_type, government_id_ref, status
         FROM donors
        WHERE tenant_id = $1::uuid
          AND (
            ($2::text IS NOT NULL AND phone = $2::text)
            OR ($3::text IS NOT NULL AND government_id_ref = $3::text)
            OR ($4::date IS NOT NULL AND lower(full_name) = lower($5::text) AND date_of_birth = $4::date)
          )
        ORDER BY registered_at DESC
        LIMIT 5`,
      tenantId,
      phone,
      governmentIdRef,
      dateOfBirth,
      fullName,
    );

    const duplicateOverrideReason = cleanText(data.duplicate_override_reason || data.duplicateOverrideReason, 500);
    if (duplicateMatches.length && (!duplicateOverrideReason || duplicateOverrideReason.length < 10)) {
      throw AppError.conflict(
        'Potential donor duplicate requires review before registration',
        'DONOR_DUPLICATE_REVIEW_REQUIRED',
        { matches: duplicateMatches },
      );
    }

    return setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO donors
           (tenant_id, full_name, phone, email, gender, date_of_birth, age_years,
            address, government_id_type, government_id_ref, abo_group, rh_factor,
            blood_group, duplicate_override_reason, duplicate_reviewed_by,
            registered_by, metadata)
         VALUES
           ($1::uuid, $2, $3, $4, $5, $6::date, $7::int,
            $8, $9, $10, $11, $12, $13, $14, $15::uuid, $16::uuid, $17::jsonb)
         RETURNING ${DONOR_RETURNING}`,
        tenantId,
        fullName,
        phone,
        cleanText(data.email, 255),
        cleanText(data.gender, 20),
        dateOfBirth,
        ageYears == null ? null : Number(ageYears),
        cleanText(data.address, 2000),
        governmentIdType,
        governmentIdRef,
        aboGroup,
        rhFactor,
        bloodGroup,
        duplicateOverrideReason,
        duplicateOverrideReason ? (context.actorUid || null) : null,
        context.actorUid || null,
        JSON.stringify(asObject(data.metadata, 'metadata')),
      );
      await recordDonorAudit(tx, {
        tenantId,
        donorId: rows[0].id,
        action: 'BLOOD_DONOR_REGISTERED',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: {
          donor_uid: rows[0].donor_uid,
          duplicate_review: duplicateMatches.length > 0,
        },
      });
      logger.info('Blood donor registered', { donorId: rows[0].id, tenantId });
      return { donor: rows[0], duplicate_matches: duplicateMatches };
    });
  }

  async listDonors(filters = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const listQuery = parseListQuery(filters, {
      defaultLimit: 50,
      maxLimit: 200,
      defaultSortBy: 'registered_at',
    });
    const conditions = ['d.tenant_id = $1::uuid'];
    const params = [tenantId];

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`d.status = $${params.length}`);
    }
    if (filters.eligibility_status) {
      params.push(filters.eligibility_status);
      conditions.push(`d.eligibility_status = $${params.length}`);
    }
    if (filters.q) {
      params.push(`%${String(filters.q).trim()}%`);
      conditions.push(`(d.full_name ILIKE $${params.length} OR d.phone ILIKE $${params.length})`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;
    const countRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM donors d ${whereClause}`,
      ...params,
    );
    const total = Number(countRows[0]?.count || 0);

    params.push(listQuery.limit);
    params.push(listQuery.offset);
    const donors = await prisma.$queryRawUnsafe(
      `SELECT d.${DONOR_RETURNING.replaceAll(', ', ', d.')},
              COALESCE(active_deferrals.count, 0)::int AS active_deferrals
         FROM donors d
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS count
             FROM donor_deferrals df
            WHERE df.tenant_id = d.tenant_id
              AND df.donor_id = d.id
              AND df.status = 'active'
              AND (df.permanent = true OR df.deferred_until IS NULL OR df.deferred_until >= CURRENT_DATE)
         ) active_deferrals ON true
         ${whereClause}
         ORDER BY d.registered_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      ...params,
    );

    return {
      donors,
      pagination: buildPagination(total, listQuery.page, listQuery.limit),
    };
  }

  async screenDonor(donorId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const donor = await loadDonor(prisma, donorId, tenantId);
    if (!donor) throw AppError.notFound('Donor not found', 'DONOR_NOT_FOUND');

    const questionnaire = asObject(data.questionnaire, 'questionnaire');
    const vitals = asObject(data.vitals, 'vitals');
    const evaluation = evaluateDeferralRules({
      dateOfBirth: donor.date_of_birth ? new Date(donor.date_of_birth).toISOString().slice(0, 10) : null,
      ageYears: donor.age_years,
      questionnaire,
      vitals,
    });

    return setTenantTx(tenantId, async (tx) => {
      const screeningRows = await tx.$queryRawUnsafe(
        `INSERT INTO donor_screenings
           (tenant_id, donor_id, questionnaire, vitals, weight_kg, hemoglobin_g_dl,
            systolic_bp, diastolic_bp, pulse_per_min, temperature_c, verdict,
            verdict_reason, deferral_reason_code, deferral_until, permanent_deferral,
            screened_by, metadata)
         VALUES
           ($1::uuid, $2::int, $3::jsonb, $4::jsonb, $5::numeric, $6::numeric,
            $7::int, $8::int, $9::int, $10::numeric, $11, $12, $13, $14::date,
            $15::boolean, $16::uuid, $17::jsonb)
         RETURNING id, tenant_id, donor_id, screening_date, questionnaire, vitals,
                   verdict, verdict_reason, deferral_reason_code, deferral_until,
                   permanent_deferral, screened_by, created_at`,
        tenantId,
        Number(donorId),
        JSON.stringify(questionnaire),
        JSON.stringify(vitals),
        vitals.weight_kg ?? vitals.weightKg ?? null,
        vitals.hemoglobin_g_dl ?? vitals.hemoglobinGdl ?? null,
        vitals.systolic_bp ?? vitals.systolicBp ?? null,
        vitals.diastolic_bp ?? vitals.diastolicBp ?? null,
        vitals.pulse_per_min ?? vitals.pulsePerMin ?? null,
        vitals.temperature_c ?? vitals.temperatureC ?? null,
        evaluation.verdict,
        evaluation.reasonText,
        evaluation.primaryReasonCode,
        evaluation.deferralUntil,
        evaluation.permanent,
        context.actorUid || null,
        JSON.stringify({ rules: evaluation.reasons, ...asObject(data.metadata, 'metadata') }),
      );

      let deferral = null;
      if (evaluation.verdict !== 'eligible') {
        const deferralRows = await tx.$queryRawUnsafe(
          `INSERT INTO donor_deferrals
             (tenant_id, donor_id, screening_id, reason_code, reason_text,
              deferred_until, permanent, source, created_by, metadata)
           VALUES ($1::uuid, $2::int, $3::int, $4, $5, $6::date, $7::boolean, 'auto', $8::uuid, $9::jsonb)
           RETURNING id, donor_id, screening_id, reason_code, reason_text, deferred_until,
                     permanent, status, source, created_at`,
          tenantId,
          Number(donorId),
          screeningRows[0].id,
          evaluation.primaryReasonCode,
          evaluation.reasonText,
          evaluation.deferralUntil,
          evaluation.permanent,
          context.actorUid || null,
          JSON.stringify({ rules: evaluation.reasons }),
        );
        deferral = deferralRows[0];
      }

      const donorStatus = evaluation.verdict === 'eligible'
        ? 'active'
        : (evaluation.permanent ? 'deferred_permanent' : 'deferred_temporary');
      await tx.$executeRawUnsafe(
        `UPDATE donors
            SET status = $3,
                eligibility_status = $4,
                last_screened_at = NOW(),
                updated_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(donorId),
        tenantId,
        donorStatus,
        evaluation.verdict,
      );
      await recordDonorAudit(tx, {
        tenantId,
        donorId,
        action: evaluation.verdict === 'eligible' ? 'BLOOD_DONOR_SCREENED_ELIGIBLE' : 'BLOOD_DONOR_DEFERRED',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: {
          screening_id: screeningRows[0].id,
          verdict: evaluation.verdict,
          deferral_id: deferral?.id || null,
          reasons: evaluation.reasons,
        },
      });

      return { screening: screeningRows[0], deferral, evaluation };
    });
  }

  async listDeferrals(filters = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const status = filters.status || 'active';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT df.id, df.donor_id, df.screening_id, df.reason_code, df.reason_text,
              df.deferred_until, df.permanent, df.status, df.source, df.created_at,
              df.reactivated_at, df.reactivation_reason,
              d.full_name, d.phone, d.blood_group
         FROM donor_deferrals df
         JOIN donors d ON d.id = df.donor_id AND d.tenant_id = df.tenant_id
        WHERE df.tenant_id = $1::uuid
          AND ($2::text IS NULL OR df.status = $2::text)
        ORDER BY df.created_at DESC
        LIMIT 200`,
      tenantId,
      status === 'all' ? null : status,
    );
    return { deferrals: rows, count: rows.length };
  }

  async reactivateDeferral(donorId, deferralId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const reason = cleanText(data.reactivation_reason || data.reason, 500);
    if (!reason || reason.length < 8) {
      throw AppError.badRequest('reactivation_reason is required', 'DONOR_REACTIVATION_REASON_REQUIRED');
    }

    return setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE donor_deferrals
            SET status = 'reactivated',
                reactivated_at = NOW(),
                reactivated_by = $4::uuid,
                reactivation_reason = $5
          WHERE id = $1::int
            AND donor_id = $2::int
            AND tenant_id = $3::uuid
            AND status = 'active'
          RETURNING id, donor_id, reason_code, reason_text, status, reactivated_at, reactivation_reason`,
        Number(deferralId),
        Number(donorId),
        tenantId,
        context.actorUid || null,
        reason,
      );
      if (!rows.length) throw AppError.notFound('Active donor deferral not found', 'DONOR_DEFERRAL_NOT_FOUND');

      const remaining = await tx.$queryRawUnsafe(
        `SELECT id
           FROM donor_deferrals
          WHERE donor_id = $1::int
            AND tenant_id = $2::uuid
            AND status = 'active'
            AND (permanent = true OR deferred_until IS NULL OR deferred_until >= CURRENT_DATE)
          LIMIT 1`,
        Number(donorId),
        tenantId,
      );
      if (!remaining.length) {
        await tx.$executeRawUnsafe(
          `UPDATE donors
              SET status = 'active',
                  eligibility_status = 'reactivated',
                  updated_at = NOW()
            WHERE id = $1::int AND tenant_id = $2::uuid`,
          Number(donorId),
          tenantId,
        );
      }
      await recordDonorAudit(tx, {
        tenantId,
        donorId,
        action: 'BLOOD_DONOR_DEFERRAL_REACTIVATED',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: { deferral_id: Number(deferralId), reason },
      });
      return rows[0];
    });
  }

  async recordDonationCollection(donorId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const donor = await loadDonor(prisma, donorId, tenantId);
    if (!donor) throw AppError.notFound('Donor not found', 'DONOR_NOT_FOUND');
    await assertNoActiveDeferral(prisma, donorId, tenantId);

    const screeningId = data.screening_id ?? data.screeningId ?? null;
    if (screeningId) {
      const screeningRows = await prisma.$queryRawUnsafe(
        `SELECT id, verdict
           FROM donor_screenings
          WHERE id = $1::int AND donor_id = $2::int AND tenant_id = $3::uuid
          LIMIT 1`,
        Number(screeningId),
        Number(donorId),
        tenantId,
      );
      if (!screeningRows.length) throw AppError.notFound('Donor screening not found', 'DONOR_SCREENING_NOT_FOUND');
      if (screeningRows[0].verdict !== 'eligible') {
        throw AppError.conflict('Only eligible screenings can be collected', 'DONOR_SCREENING_NOT_ELIGIBLE');
      }
    }

    const volumeMl = Number(data.volume_ml ?? data.volumeMl);
    if (!Number.isInteger(volumeMl) || volumeMl < 100 || volumeMl > 650) {
      throw AppError.badRequest('volume_ml must be between 100 and 650', 'DONATION_BAD_VOLUME');
    }

    const collectionKind = cleanText(data.collection_kind || data.collectionKind, 20) || 'in_house';
    const barcode = cleanText(data.donation_barcode || data.donationBarcode, 80) || donationBarcode(tenantId, donorId);
    const donationCode = cleanText(data.donation_code || data.donationCode, 60) || barcode;
    const campId = data.camp_id ?? data.campId ?? null;
    if (campId != null) {
      const campRows = await prisma.$queryRawUnsafe(
        `SELECT id
           FROM donor_camps
          WHERE id = $1::int AND tenant_id = $2::uuid
          LIMIT 1`,
        Number(campId),
        tenantId,
      ).catch((err) => {
        if (err?.code === 'P2010' || String(err?.message || '').includes('donor_camps')) return [];
        throw err;
      });
      if (!campRows.length) throw AppError.notFound('Donor camp not found', 'DONOR_CAMP_NOT_FOUND');
    }
    const preVitals = asObject(data.pre_vitals || data.preVitals, 'pre_vitals');
    const postVitals = asObject(data.post_vitals || data.postVitals, 'post_vitals');
    const adverseReaction = data.adverse_reaction === true || data.adverseReaction === true;

    return setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO donation_events
           (tenant_id, donor_id, screening_id, donation_code, donation_barcode,
            collection_kind, camp_id, camp_name, camp_location, pre_vitals, post_vitals,
            volume_ml, collected_by, barcode_printed_at, barcode_scanned_at,
            barcode_scan_match, adverse_reaction, adverse_reaction_type,
            adverse_reaction_severity, adverse_reaction_notes,
            adverse_reaction_intervention, adverse_reaction_outcome, metadata)
         VALUES
           ($1::uuid, $2::int, $3::int, $4, $5, $6, $7::int, $8, $9, $10::jsonb, $11::jsonb,
            $12::int, $13::uuid, $14::timestamptz, $15::timestamptz, $16::boolean,
            $17::boolean, $18, $19, $20, $21, $22, $23::jsonb)
         RETURNING id, donor_id, screening_id, donation_code, donation_barcode,
                   collection_kind, volume_ml, status, collected_at, collected_by,
                   barcode_scanned_at, barcode_scan_match, adverse_reaction,
                   adverse_reaction_type, adverse_reaction_severity, adverse_reaction_notes`,
        tenantId,
        Number(donorId),
        screeningId == null ? null : Number(screeningId),
        donationCode,
        barcode,
        collectionKind,
        campId == null ? null : Number(campId),
        cleanText(data.camp_name || data.campName, 160),
        cleanText(data.camp_location || data.campLocation, 2000),
        JSON.stringify(preVitals),
        JSON.stringify(postVitals),
        volumeMl,
        context.actorUid || null,
        data.barcode_printed_at || data.barcodePrintedAt || null,
        data.barcode_scanned_at || data.barcodeScannedAt || new Date().toISOString(),
        data.barcode_scan_match ?? data.barcodeScanMatch ?? true,
        adverseReaction,
        cleanText(data.adverse_reaction_type || data.adverseReactionType, 60),
        cleanText(data.adverse_reaction_severity || data.adverseReactionSeverity, 20),
        cleanText(data.adverse_reaction_notes || data.adverseReactionNotes, 2000),
        cleanText(data.adverse_reaction_intervention || data.adverseReactionIntervention, 2000),
        cleanText(data.adverse_reaction_outcome || data.adverseReactionOutcome, 1000),
        JSON.stringify(asObject(data.metadata, 'metadata')),
      );
      if (campId != null) {
        await tx.$executeRawUnsafe(
          `UPDATE donor_camps
              SET collected_units = collected_units + 1,
                  updated_at = NOW()
            WHERE id = $1::int AND tenant_id = $2::uuid`,
          Number(campId),
          tenantId,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE donors
            SET status = 'active',
                eligibility_status = 'collected',
                last_donated_at = NOW(),
                updated_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(donorId),
        tenantId,
      );
      await recordDonorAudit(tx, {
        tenantId,
        donorId,
        action: adverseReaction ? 'BLOOD_DONATION_COLLECTED_WITH_REACTION' : 'BLOOD_DONATION_COLLECTED',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: {
          donation_event_id: rows[0].id,
          donation_barcode: rows[0].donation_barcode,
          adverse_reaction: adverseReaction,
        },
      });
      return rows[0];
    });
  }

  async captureDonorConsent(donorId, data = {}, context = {}) {
    const tenantId = requireTenantId(context.tenantId);
    const donor = await loadDonor(prisma, donorId, tenantId);
    if (!donor) throw AppError.notFound('Donor not found', 'DONOR_NOT_FOUND');

    const consentType = cleanText(data.consent_type || data.consentType, 40) || 'blood_donation';
    const consentStatement = cleanText(data.consent_statement || data.consentStatement, 4000);
    if (!consentStatement) {
      throw AppError.badRequest('consent_statement is required', 'DONOR_CONSENT_STATEMENT_REQUIRED');
    }
    const consentPayload = asObject(data.consent_payload || data.consentPayload, 'consent_payload');

    return setTenantTx(tenantId, async (tx) => {
      let version = data.consent_version || data.consentVersion || null;
      if (!version) {
        const maxRows = await tx.$queryRawUnsafe(
          `SELECT COALESCE(MAX(consent_version), 0)::int + 1 AS next_version
             FROM donor_consents
            WHERE tenant_id = $1::uuid
              AND donor_id = $2::int
              AND consent_type = $3`,
          tenantId,
          Number(donorId),
          consentType,
        );
        version = Number(maxRows[0].next_version);
      }

      const hash = crypto.createHash('sha256').update(JSON.stringify({
        donor_id: Number(donorId),
        consent_type: consentType,
        consent_version: Number(version),
        consent_statement: consentStatement,
        consent_payload: consentPayload,
        signer_name: data.signer_name || data.signerName || null,
      })).digest('hex');

      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO donor_consents
           (tenant_id, donor_id, consent_type, consent_version, consent_statement,
            consent_payload, storage_key, storage_url, mime_type, file_size,
            sha256_hash, captured_by, captured_by_role, signer_name, signer_uid, metadata)
         VALUES
           ($1::uuid, $2::int, $3, $4::int, $5, $6::jsonb, $7, $8, $9,
            $10::int, $11, $12::uuid, $13, $14, $15::uuid, $16::jsonb)
         RETURNING id, donor_id, consent_type, consent_version, sha256_hash,
                   captured_by, captured_by_role, signer_name, signer_uid,
                   captured_at, created_at`,
        tenantId,
        Number(donorId),
        consentType,
        Number(version),
        consentStatement,
        JSON.stringify(consentPayload),
        cleanText(data.storage_key || data.storageKey, 1000),
        cleanText(data.storage_url || data.storageUrl, 1000),
        cleanText(data.mime_type || data.mimeType, 100),
        data.file_size ?? data.fileSize ?? null,
        hash,
        context.actorUid || null,
        context.actorRole || null,
        cleanText(data.signer_name || data.signerName, 160),
        data.signer_uid || data.signerUid || null,
        JSON.stringify(asObject(data.metadata, 'metadata')),
      );
      await recordDonorAudit(tx, {
        tenantId,
        donorId,
        action: 'BLOOD_DONOR_CONSENT_CAPTURED',
        actorUid: context.actorUid,
        actorRole: context.actorRole,
        metadata: {
          consent_id: rows[0].id,
          consent_type: consentType,
          consent_version: Number(version),
          sha256_hash: hash,
        },
      });
      return rows[0];
    });
  }
}

export default new DonorIntakeService();
