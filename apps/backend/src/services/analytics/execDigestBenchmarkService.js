import { prismaReadOnly, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';

export const EXEC_DIGEST_CHANNELS = Object.freeze(['inapp', 'push']);
export const EXEC_DIGEST_CHANNEL_POLICY = 'in_app_push_locked';
export const BENCHMARK_VISIBILITY = 'internal';
export const BENCHMARK_SUPPRESSION_POLICY = 'min_cell_locked';
export const MIN_BENCHMARK_CELL_THRESHOLD = 5;

function toIsoDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${toIsoDate(dateText)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toWireValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toNumber === 'function') return value.toNumber();
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toWireValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, toWireValue(val)]));
  }
  return value;
}

function toFiniteNumber(value, fallback = 0) {
  const shaped = toWireValue(value);
  const parsed = Number(shaped);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function shapeMetricRow(row = {}) {
  return toWireValue(row);
}

function round1(value) {
  return Math.round(toFiniteNumber(value, 0) * 10) / 10;
}

function suppressSmallCell(row, {
  countField = 'sample_size',
  threshold = MIN_BENCHMARK_CELL_THRESHOLD,
  protectedFields = [],
} = {}) {
  const shaped = shapeMetricRow(row);
  const sampleSize = toFiniteNumber(shaped[countField], 0);
  if (sampleSize >= threshold) {
    return {
      row: {
        ...shaped,
        sample_visible: true,
        minimum_cell_threshold: threshold,
      },
      suppressed: false,
    };
  }

  const suppressedRow = {
    ...shaped,
    sample_visible: false,
    minimum_cell_threshold: threshold,
  };
  for (const field of protectedFields) {
    if (Object.prototype.hasOwnProperty.call(suppressedRow, field)) {
      suppressedRow[field] = null;
    }
  }
  return { row: suppressedRow, suppressed: true };
}

function summarizeDigestRows({
  digestDate,
  encounterRows = [],
  revenueRows = [],
  otRows = [],
  bedRows = [],
  alertRows = [],
}) {
  const encounters = encounterRows.map(shapeMetricRow);
  const revenue = shapeMetricRow(revenueRows[0] || {});
  const ot = shapeMetricRow(otRows[0] || {});
  const beds = shapeMetricRow(bedRows[0] || {});
  const alerts = shapeMetricRow(alertRows[0] || {});
  const volumes = {
    opd: 0,
    ipd: 0,
    er: 0,
  };

  for (const row of encounters) {
    const key = String(row.encounter_type || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(volumes, key)) {
      volumes[key] += toFiniteNumber(row.encounter_count, 0);
    }
  }

  return {
    digest_date: toIsoDate(digestDate),
    delivery_channels: [...EXEC_DIGEST_CHANNELS],
    delivery_channel_policy: EXEC_DIGEST_CHANNEL_POLICY,
    source: 'analytics_marts',
    metrics: {
      volumes,
      bed_flow: {
        midnight_census: toFiniteNumber(beds.midnight_census, 0),
        occupancy_pct: beds.occupancy_pct == null ? null : round1(beds.occupancy_pct),
        discharges_out: toFiniteNumber(beds.discharges_out, 0),
      },
      ot_utilization: {
        cases_completed: toFiniteNumber(ot.cases_completed, 0),
        utilization_pct: ot.utilization_pct == null ? null : round1(ot.utilization_pct),
      },
      revenue: {
        invoices: toFiniteNumber(revenue.invoices, 0),
        gross_billed: toFiniteNumber(revenue.gross_billed, 0),
        collected: toFiniteNumber(revenue.collected, 0),
        outstanding: toFiniteNumber(revenue.outstanding, 0),
      },
      operational_alerts: {
        high: toFiniteNumber(alerts.high_alerts, 0),
        critical: toFiniteNumber(alerts.critical_alerts, 0),
      },
    },
  };
}

function formatDigestBody(summary) {
  const { metrics } = summary;
  const parts = [
    `OPD ${metrics.volumes.opd}`,
    `IPD ${metrics.volumes.ipd}`,
    `ER ${metrics.volumes.er}`,
  ];
  if (metrics.bed_flow.occupancy_pct !== null) {
    parts.push(`bed occupancy ${metrics.bed_flow.occupancy_pct}%`);
  }
  if (metrics.ot_utilization.utilization_pct !== null) {
    parts.push(`OT utilization ${metrics.ot_utilization.utilization_pct}%`);
  }
  parts.push(`collections ${metrics.revenue.collected}`);
  if (metrics.operational_alerts.critical > 0 || metrics.operational_alerts.high > 0) {
    parts.push(
      `${metrics.operational_alerts.critical} critical and ${metrics.operational_alerts.high} high operational alerts`
    );
  }
  return `Executive digest ${summary.digest_date}: ${parts.join(' | ')}`;
}

export async function buildExecDigestSummary({ tenantId, digestDate = new Date() } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const dateText = toIsoDate(digestDate);
  const monthStart = `${dateText.slice(0, 7)}-01`;

  const [encounterRows, revenueRows, otRows, bedRows, alertRows] = await Promise.all([
    prismaReadOnly.$queryRawUnsafe(
      `SELECT encounter_type, COUNT(*)::int AS encounter_count
         FROM analytics_marts.fct_encounters
        WHERE tenant_id = $1::uuid
          AND encounter_date = $2::date
        GROUP BY encounter_type
        ORDER BY encounter_type`,
      scopedTenantId,
      dateText,
    ),
    prismaReadOnly.$queryRawUnsafe(
      `SELECT
          COUNT(DISTINCT invoice_id)::int AS invoices,
          COALESCE(SUM(line_total) FILTER (WHERE NOT is_voided), 0)::numeric AS gross_billed,
          0::numeric AS collected,
          COALESCE(SUM(line_total) FILTER (WHERE NOT is_voided), 0)::numeric AS outstanding
         FROM analytics_marts.fct_revenue
        WHERE tenant_id = $1::uuid
          AND invoice_month = $2::date`,
      scopedTenantId,
      monthStart,
    ),
    prismaReadOnly.$queryRawUnsafe(
      `SELECT
          COALESCE(SUM(cases_completed), 0)::int AS cases_completed,
          ROUND(AVG(utilization_pct), 1)::numeric AS utilization_pct
         FROM analytics_marts.mart_ot_utilization_daily
        WHERE date_day = $1::date`,
      dateText,
    ),
    prismaReadOnly.$queryRawUnsafe(
      `SELECT
          COALESCE(SUM(midnight_census), 0)::int AS midnight_census,
          COALESCE(SUM(discharges_out), 0)::int AS discharges_out,
          ROUND(AVG(occupancy_pct), 1)::numeric AS occupancy_pct
         FROM analytics_marts.mart_bed_flow_daily
        WHERE date_day = $1::date`,
      dateText,
    ),
    prismaReadOnly.$queryRawUnsafe(
      `SELECT 0::int AS high_alerts, 0::int AS critical_alerts`,
    ),
  ]);

  return {
    period_start: dateText,
    period_end: dateText,
    summary: summarizeDigestRows({
      digestDate: dateText,
      encounterRows,
      revenueRows,
      otRows,
      bedRows,
      alertRows,
    }),
    warehouse_snapshot: {
      source: 'analytics_marts',
      datasets: [
        'fct_encounters',
        'fct_revenue',
        'mart_ot_utilization_daily',
        'mart_bed_flow_daily',
      ],
      generated_at: new Date().toISOString(),
    },
  };
}

export async function listExecDigestRecipients({ tenantId, targetUserUid = null, targetRole = null } = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  if (targetUserUid) {
    return prismaReadOnly.$queryRawUnsafe(
      `SELECT id, uid, phone, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND COALESCE(is_active, true) = true
        LIMIT 1`,
      scopedTenantId,
      targetUserUid,
    );
  }
  if (targetRole) {
    return prismaReadOnly.$queryRawUnsafe(
      `SELECT id, uid, phone, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND role = $2
          AND COALESCE(is_active, true) = true
        ORDER BY id`,
      scopedTenantId,
      String(targetRole),
    );
  }
  return [];
}

export async function queueExecDigestDelivery({
  tenantId,
  subscription,
  recipient,
  digestDate = new Date(),
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  if (!recipient?.uid) throw new Error('exec digest recipient uid is required');
  const digest = await buildExecDigestSummary({ tenantId: scopedTenantId, digestDate });
  const body = formatDigestBody(digest.summary);
  const title = `Executive digest - ${digest.summary.digest_date}`;
  const payload = {
    tenant_id: scopedTenantId,
    kind: 'exec_digest',
    channels: [...EXEC_DIGEST_CHANNELS],
    channel_policy: EXEC_DIGEST_CHANNEL_POLICY,
    digest: digest.summary,
  };

  const result = await setTenantTx(scopedTenantId, async (tx) => {
    const notificationRows = await tx.$queryRawUnsafe(
      `INSERT INTO notifications
        (tenant_id, user_id, uid, phone, title, body, type, priority, data,
         is_read, created_at, updated_at)
       VALUES
        ($1::uuid, $2::int, $3::uuid, COALESCE($4, ''), $5, $6, 'exec_digest',
         'NORMAL', $7::jsonb, false, NOW(), NOW())
       RETURNING id`,
      scopedTenantId,
      recipient.id,
      recipient.uid,
      recipient.phone || '',
      title,
      body,
      JSON.stringify(payload),
    );
    const outboxRows = await tx.$queryRawUnsafe(
      `INSERT INTO notification_outbox
        (tenant_id, type, recipient_id, recipient_phone, title, body, payload,
         status, created_at)
       VALUES
        ($1::uuid, 'exec_digest', $2, $3, $4, $5, $6::jsonb, 'PENDING', NOW())
       RETURNING id, status`,
      scopedTenantId,
      String(recipient.id),
      recipient.phone || null,
      title,
      body,
      JSON.stringify(payload),
    );
    const deliveryRows = await tx.$queryRawUnsafe(
      `INSERT INTO analytics_exec_digest_deliveries
        (tenant_id, subscription_id, target_user_uid, target_role, digest_date,
         period_start, period_end, metric_bundle, delivery_channels,
         delivery_channel_policy, warehouse_snapshot, summary_payload,
         in_app_notification_id, notification_outbox_id, status, generated_at,
         created_at, updated_at)
       VALUES
        ($1::uuid, $2::bigint, $3::uuid, $4, $5::date, $6::date, $7::date,
         $8, ARRAY['inapp','push']::text[], $9, $10::jsonb, $11::jsonb,
         $12::int, $13::int, 'queued', NOW(), NOW(), NOW())
       RETURNING id, status, delivery_channels`,
      scopedTenantId,
      subscription?.id || null,
      recipient.uid,
      subscription?.target_role || recipient.role || null,
      digest.summary.digest_date,
      digest.period_start,
      digest.period_end,
      subscription?.metric_bundle || 'executive_core',
      EXEC_DIGEST_CHANNEL_POLICY,
      JSON.stringify(digest.warehouse_snapshot),
      JSON.stringify(digest.summary),
      notificationRows[0]?.id || null,
      outboxRows[0]?.id || null,
    );

    return {
      delivery: shapeMetricRow(deliveryRows[0]),
      notification: shapeMetricRow(notificationRows[0]),
      outbox: shapeMetricRow(outboxRows[0]),
      summary: digest.summary,
    };
  });

  logger.info('exec digest queued', {
    tenant_id: scopedTenantId,
    delivery_id: result.delivery?.id,
    recipient_uid: recipient.uid,
  });
  return result;
}

function buildBenchmarkMetrics({ revenueRows = [], encounterRows = [] } = {}) {
  const threshold = MIN_BENCHMARK_CELL_THRESHOLD;
  const suppressed = [];
  const revenue = revenueRows.map((row) => {
    const result = suppressSmallCell(row, {
      countField: 'invoices',
      threshold,
      protectedFields: ['gross_billed', 'collected', 'outstanding'],
    });
    if (result.suppressed) suppressed.push({ dataset: 'department_revenue', key: row.department });
    return result.row;
  });
  const encounters = encounterRows.map((row) => {
    const result = suppressSmallCell(row, {
      countField: 'encounters',
      threshold,
      protectedFields: ['encounters'],
    });
    if (result.suppressed) suppressed.push({ dataset: 'encounter_mix', key: row.encounter_type });
    return result.row;
  });

  return {
    visibility: BENCHMARK_VISIBILITY,
    suppression_policy: BENCHMARK_SUPPRESSION_POLICY,
    minimum_cell_threshold: threshold,
    datasets: {
      department_revenue: revenue,
      encounter_mix: encounters,
    },
    suppressed_cells_count: suppressed.length,
    suppression_metadata: {
      suppressed,
      reason: 'minimum_cell_threshold',
    },
  };
}

export async function buildInternalBenchmarkPack({
  tenantId,
  periodStart,
  periodEnd,
  generatedBy = null,
} = {}) {
  const scopedTenantId = requireTenantId(tenantId);
  const start = toIsoDate(periodStart || addDays(new Date(), -30));
  const end = toIsoDate(periodEnd || new Date());
  const [revenueRows, encounterRows] = await Promise.all([
    prismaReadOnly.$queryRawUnsafe(
      `SELECT
          COALESCE(department, 'Unassigned') AS department,
          COUNT(DISTINCT invoice_id)::int AS invoices,
          COALESCE(SUM(line_total) FILTER (WHERE NOT is_voided), 0)::numeric AS gross_billed,
          0::numeric AS collected,
          COALESCE(SUM(line_total) FILTER (WHERE NOT is_voided), 0)::numeric AS outstanding
         FROM analytics_marts.fct_revenue
        WHERE tenant_id = $1::uuid
          AND issued_at::date BETWEEN $2::date AND $3::date
        GROUP BY COALESCE(department, 'Unassigned')
        ORDER BY department`,
      scopedTenantId,
      start,
      end,
    ),
    prismaReadOnly.$queryRawUnsafe(
      `SELECT
          encounter_type,
          COUNT(*)::int AS encounters
         FROM analytics_marts.fct_encounters
        WHERE tenant_id = $1::uuid
          AND encounter_date BETWEEN $2::date AND $3::date
        GROUP BY encounter_type
        ORDER BY encounter_type`,
      scopedTenantId,
      start,
      end,
    ),
  ]);
  const metrics = buildBenchmarkMetrics({ revenueRows, encounterRows });

  const rows = await setTenantTx(scopedTenantId, async (tx) => tx.$queryRawUnsafe(
    `INSERT INTO analytics_benchmark_pack_exports
      (tenant_id, pack_key, period_start, period_end, visibility,
       external_sharing_allowed, minimum_cell_threshold, suppression_policy,
       included_datasets, metrics_payload, suppression_metadata,
       suppressed_cells_count, approval_status, generated_by, generated_at,
       created_at, updated_at)
     VALUES
      ($1::uuid, 'executive_internal_v1', $2::date, $3::date, 'internal',
       false, $4::int, $5, ARRAY['fct_revenue','fct_encounters']::text[],
       $6::jsonb, $7::jsonb, $8::int, 'not_requested', $9::uuid, NOW(),
       NOW(), NOW())
     ON CONFLICT (tenant_id, pack_key, period_start, period_end) DO UPDATE SET
       metrics_payload = EXCLUDED.metrics_payload,
       suppression_metadata = EXCLUDED.suppression_metadata,
       suppressed_cells_count = EXCLUDED.suppressed_cells_count,
       generated_by = EXCLUDED.generated_by,
       generated_at = NOW(),
       updated_at = NOW()
     RETURNING id, visibility, external_sharing_allowed, minimum_cell_threshold,
               suppression_policy, suppressed_cells_count, metrics_payload,
               suppression_metadata`,
    scopedTenantId,
    start,
    end,
    metrics.minimum_cell_threshold,
    metrics.suppression_policy,
    JSON.stringify(metrics),
    JSON.stringify(metrics.suppression_metadata),
    metrics.suppressed_cells_count,
    generatedBy,
  ));

  return shapeMetricRow(rows[0]);
}

export const __testing__ = {
  buildBenchmarkMetrics,
  EXEC_DIGEST_CHANNELS,
  EXEC_DIGEST_CHANNEL_POLICY,
  formatDigestBody,
  shapeMetricRow,
  summarizeDigestRows,
  suppressSmallCell,
  toWireValue,
};
