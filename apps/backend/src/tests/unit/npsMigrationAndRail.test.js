import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migration452Path = path.resolve(__dirname, '../../migrations/452_feedback_nps_responses.sql');
const migration453Path = path.resolve(__dirname, '../../migrations/453_feedback_nps_rollups.sql');
const npsServicePath = path.resolve(__dirname, '../../services/feedback/npsService.js');
const tierHPath = path.resolve(__dirname, '../../services/ai/tierHOperationalService.js');
const appointmentWorkflowPath = path.resolve(__dirname, '../../controllers/appointment/appointmentWorkflowController.js');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function tableBlock(sql, table) {
  const match = sql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`, 'i'),
  );
  return match?.[0] || '';
}

describe('NL9-P2 NPS migrations', () => {
  let npsResponses;
  let npsRollups;

  beforeAll(() => {
    npsResponses = read(migration452Path);
    npsRollups = read(migration453Path);
  });

  it('uses the assigned 452 and 453 migration block with transaction wrappers', () => {
    expect(npsResponses).toMatch(/^-- 452_feedback_nps_responses\.sql/m);
    expect(npsRollups).toMatch(/^-- 453_feedback_nps_rollups\.sql/m);
    expect(npsResponses).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
    expect(npsRollups).toMatch(/^\s*BEGIN;[\s\S]*COMMIT;\s*$/m);
  });

  it('creates a dedicated tenant-scoped NPS response ledger', () => {
    const block = tableBlock(npsResponses, 'feedback_nps_responses');
    expect(block).toMatch(/tenant_id\s+UUID NOT NULL REFERENCES tenants\(id\) ON DELETE CASCADE/i);
    expect(block).toMatch(/patient_uid\s+UUID NOT NULL REFERENCES users\(uid\)/i);
    expect(block).toMatch(/score\s+SMALLINT NOT NULL CHECK \(score BETWEEN 0 AND 10\)/i);
    expect(block).toMatch(/nps_bucket\s+VARCHAR\(20\) NOT NULL/i);
    expect(block).toMatch(/consent_id\s+INTEGER REFERENCES patient_consents\(id\)/i);
    expect(block).toMatch(/source_campaign_recipient_id\s+BIGINT/i);
    expect(block).toMatch(/dedupe_key\s+VARCHAR\(160\) NOT NULL/i);
    expect(npsResponses).toMatch(/CONSTRAINT feedback_nps_bucket_score_ck CHECK/i);
    expect(npsResponses).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_nps_responses_dedupe[\s\S]*\(tenant_id, dedupe_key\)/i);
  });

  it('creates aggregate rollups with sample suppression and response-rate context', () => {
    const block = tableBlock(npsRollups, 'feedback_nps_rollups');
    expect(block).toMatch(/grain\s+VARCHAR\(10\) NOT NULL/i);
    expect(block).toMatch(/dimension_type\s+VARCHAR\(40\) NOT NULL DEFAULT 'tenant'/i);
    expect(block).toMatch(/request_count\s+INTEGER NOT NULL DEFAULT 0/i);
    expect(block).toMatch(/response_rate\s+NUMERIC\(6,2\)/i);
    expect(block).toMatch(/minimum_sample_size\s+INTEGER NOT NULL DEFAULT 5/i);
    expect(block).toMatch(/sample_visible\s+BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(block).toMatch(/CONSTRAINT feedback_nps_rollup_counts_ck CHECK/i);
    expect(npsRollups).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_nps_rollups_slice[\s\S]*\(tenant_id, grain, period_start, dimension_type, dimension_key\)/i);
  });

  it('enables forced tenant RLS on both NPS tables', () => {
    for (const sql of [npsResponses, npsRollups]) {
      expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
      expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
      expect(sql).toMatch(/CREATE POLICY tenant_isolation/i);
      expect(sql).toMatch(/tenant_id = app_current_tenant_id_uuid\(\)/i);
    }
  });
});

describe('NL9-P2 NPS service and scheduled request rail', () => {
  it('repairs the Tier H feedback summary schema gap through feedback_nps_responses', () => {
    const tierH = read(tierHPath);
    expect(tierH).toMatch(/FROM feedback_nps_responses n/i);
    expect(tierH).not.toMatch(/feedback\.nps_score/i);
  });

  it('keeps dashboard SQL sample-suppressed and Decimal-safe for wire responses', () => {
    const service = read(npsServicePath);
    expect(service).toMatch(/function maybeNumber/i);
    expect(service).toMatch(/typeof value\?\.toNumber === 'function'/i);
    expect(service).toMatch(/COUNT\(\*\) >= \$3::int/i);
    expect(service).toMatch(/THEN ROUND\(\(\(COUNT\(\*\) FILTER \(WHERE nps_bucket = 'promoter'\)/i);
    expect(service).toMatch(/sn\.type IN \('feedback_request', 'nps_request'\)/i);
    expect(service).toMatch(/jsonb_build_object\('days', \$2::int, 'refreshed_by', 'nl9_p2_nps'::text\)/i);
  });

  it('creates service recovery tasks and deliverable quality/admin outbox notifications', () => {
    const service = read(npsServicePath);
    expect(service).toMatch(/relatedResourceType: 'feedback_nps_response'/);
    expect(service).toMatch(/assignedToRole: 'QUALITY_OFFICER'/);
    expect(service).toMatch(/role IN \('QUALITY_OFFICER', 'ADMIN', 'SUPER_ADMIN'\)/);
    expect(service).toMatch(/recipientId: recipient\.id/);
    expect(service).toMatch(/tenant_id: tenantId/);
  });

  it('gates post-appointment NPS requests on consent and dedupes the appointment survey', () => {
    const workflow = read(appointmentWorkflowPath);
    expect(workflow).toMatch(/INSERT INTO scheduled_notifications \(user_id, type, data, send_at, status\)/);
    expect(workflow).toMatch(/pc\.consent_type IN \('nps_survey', 'feedback', 'patient_feedback', 'care_reminder_push', 'care_reminder_whatsapp'\)/);
    expect(workflow).toMatch(/pc\.granted IS TRUE/);
    expect(workflow).toMatch(/pc\.revoked_at IS NULL/);
    expect(workflow).toMatch(/COALESCE\(sn\.data->>'appointment_id', ''\) = \$3::text/);
    expect(workflow).toMatch(/COALESCE\(sn\.data->>'survey', ''\) = 'nps'/);
    expect(workflow).toMatch(/sn\.status IN \('pending', 'sent'\)/);
    expect(workflow).toMatch(/survey: 'nps'/);
  });
});
