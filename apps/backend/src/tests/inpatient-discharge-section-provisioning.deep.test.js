import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  planInpatientDischargeSectionProvisioning,
  provisionInpatientDischargeSectionsTx,
} from '../../scripts/lib/provision-inpatient-discharge-sections.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const REQUIRED_SECTION_KEYS = [
  'patient_guardian_instructions',
  'escalation_contact',
  'required_equipment_home_care',
  'discharge_destination',
  'transport_plan',
];

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedFixture(client) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name, settings)
     VALUES (
       $1::uuid,
       $2::text,
       'S4 inpatient discharge provisioning',
       '{"care_pathways":{"inpatient_admission_to_recovery":"shadow"}}'::jsonb
     )`,
    [tenantId, `s4-discharge-provision-${token()}`],
  );
  const template = await client.query(
    `INSERT INTO discharge_summary_templates
       (tenant_id, code, display_name, sections, active)
     VALUES (
       $1::uuid,
       $2::text,
       'S4 inpatient discharge provisioning',
       '[
          {
            "section_key":"diagnosis",
            "section_title":"Diagnosis",
            "display_order":17
          },
          {
            "section_key":"transport_plan",
            "section_title":"Existing transport plan",
            "display_order":4,
            "default_body":"Preserve template content"
          }
        ]'::jsonb,
       TRUE
     )
     RETURNING id`,
    [tenantId, `S4_INPATIENT_PROVISION_${token()}`],
  );

  const summaries = await client.query(
    `INSERT INTO discharge_summaries
       (tenant_id, patient_uid, hospital_number, status, signed_by,
        signed_by_name, signed_by_reg, signed_at, delivered_at)
     VALUES
       ($1::uuid, gen_random_uuid(), $2::text, 'draft',
        NULL, NULL, NULL, NULL, NULL),
       ($1::uuid, gen_random_uuid(), $3::text, 'ready_for_signoff',
        NULL, NULL, NULL, NULL, NULL),
       ($1::uuid, gen_random_uuid(), $4::text, 'signed',
        gen_random_uuid(), 'Signer', 'REG-1', NOW(), NULL),
       ($1::uuid, gen_random_uuid(), $5::text, 'delivered',
        gen_random_uuid(), 'Signer', 'REG-2', NOW(), NOW()),
       ($1::uuid, gen_random_uuid(), $6::text, 'draft',
        gen_random_uuid(), 'Signer', 'REG-3', NOW(), NULL)
     RETURNING id, hospital_number, status`,
    [
      tenantId,
      `S4-DRAFT-${token()}`,
      `S4-READY-${token()}`,
      `S4-SIGNED-${token()}`,
      `S4-DELIVERED-${token()}`,
      `S4-ANOMALOUS-${token()}`,
    ],
  );
  for (const summary of summaries.rows) {
    await client.query(
      `INSERT INTO discharge_summary_sections
         (tenant_id, discharge_summary_id, section_key, section_title,
          display_order, body)
       VALUES ($1::uuid, $2::integer, 'diagnosis', 'Diagnosis', 17,
               'Existing diagnosis')`,
      [tenantId, Number(summary.id)],
    );
  }
  const draft = summaries.rows.find((summary) => summary.status === 'draft');
  await client.query(
    `INSERT INTO discharge_summary_sections
       (tenant_id, discharge_summary_id, section_key, section_title,
        display_order, body)
     VALUES (
       $1::uuid,
       $2::integer,
       'patient_guardian_instructions',
       'Existing patient instructions',
       2,
       'Preserve authored content'
     )`,
    [tenantId, Number(draft.id)],
  );

  return {
    tenantId,
    templateId: Number(template.rows[0].id),
    draftId: Number(draft.id),
    summaries: summaries.rows.map((summary) => ({
      id: Number(summary.id),
      hospitalNumber: summary.hospital_number,
      status: summary.status,
    })),
  };
}

async function snapshotFixture(client, fixture) {
  const template = await client.query(
    `SELECT sections
       FROM discharge_summary_templates
      WHERE tenant_id = $1::uuid
        AND id = $2::integer`,
    [fixture.tenantId, fixture.templateId],
  );
  const sections = await client.query(
    `SELECT discharge_summary_id,
            jsonb_agg(to_jsonb(section) ORDER BY section.id) AS rows
       FROM discharge_summary_sections AS section
      WHERE section.tenant_id = $1::uuid
        AND section.discharge_summary_id = ANY($2::integer[])
      GROUP BY discharge_summary_id
      ORDER BY discharge_summary_id`,
    [fixture.tenantId, fixture.summaries.map((summary) => summary.id)],
  );
  return {
    template: template.rows[0].sections,
    sections: sections.rows,
  };
}

describeIfDb('inpatient discharge-section shadow provisioning', () => {
  let client;
  let fixture;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.current_tenant_id = 'bypass'");
    fixture = await seedFixture(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client.end();
  });

  test('dry-run reports exact work and leaves every row unchanged', async () => {
    const before = await snapshotFixture(client, fixture);

    await expect(
      planInpatientDischargeSectionProvisioning(client, {
        tenantId: fixture.tenantId,
      }),
    ).resolves.toEqual({
      required_section_count: 5,
      templates_to_update: 1,
      template_definitions_to_add: 4,
      unsigned_summaries_to_update: 2,
      summary_sections_to_add: 9,
    });

    await expect(snapshotFixture(client, fixture)).resolves.toEqual(before);
  });

  test('apply is missing-only, append-ordered, protected, and idempotent', async () => {
    const protectedIds = fixture.summaries
      .filter((summary) => (
        summary.status === 'signed'
        || summary.status === 'delivered'
        || summary.hospitalNumber.includes('ANOMALOUS')
      ))
      .map((summary) => summary.id);
    const protectedBefore = await client.query(
      `SELECT discharge_summary_id,
              jsonb_agg(to_jsonb(section) ORDER BY section.id) AS rows
         FROM discharge_summary_sections AS section
        WHERE section.discharge_summary_id = ANY($1::integer[])
        GROUP BY discharge_summary_id
        ORDER BY discharge_summary_id`,
      [protectedIds],
    );

    await expect(
      provisionInpatientDischargeSectionsTx(client, {
        tenantId: fixture.tenantId,
      }),
    ).resolves.toEqual({
      required_section_count: 5,
      templates_updated: 1,
      template_definitions_added: 4,
      unsigned_summaries_updated: 2,
      summary_sections_added: 9,
    });

    const template = await client.query(
      `SELECT section.value
         FROM discharge_summary_templates AS template
         CROSS JOIN LATERAL jsonb_array_elements(
           template.sections
         ) AS section(value)
        WHERE template.tenant_id = $1::uuid
          AND template.id = $2::integer`,
      [fixture.tenantId, fixture.templateId],
    );
    const templateSections = template.rows.map((row) => row.value);
    expect(
      templateSections.filter((section) => (
        REQUIRED_SECTION_KEYS.includes(section.section_key)
      )),
    ).toHaveLength(5);
    expect(
      templateSections.find((section) => (
        section.section_key === 'transport_plan'
      )),
    ).toMatchObject({
      section_title: 'Existing transport plan',
      display_order: 4,
      default_body: 'Preserve template content',
    });
    for (const section of templateSections.filter((candidate) => (
      REQUIRED_SECTION_KEYS.includes(candidate.section_key)
      && candidate.section_key !== 'transport_plan'
    ))) {
      expect(section.display_order).toBeGreaterThan(17);
      expect(section.default_body).toBe('');
    }

    const eligibleIds = fixture.summaries
      .filter((summary) => (
        summary.status === 'draft'
        && !summary.hospitalNumber.includes('ANOMALOUS')
      ) || summary.status === 'ready_for_signoff')
      .map((summary) => summary.id);
    const eligible = await client.query(
      `SELECT discharge_summary_id,
              COUNT(*) FILTER (
                WHERE section_key = ANY($2::text[])
              )::integer AS required_count,
              BOOL_AND(body IS NULL) FILTER (
                WHERE section_key = ANY($2::text[])
                  AND section_key <> 'patient_guardian_instructions'
              ) AS added_bodies_blank
         FROM discharge_summary_sections
        WHERE discharge_summary_id = ANY($1::integer[])
        GROUP BY discharge_summary_id`,
      [eligibleIds, REQUIRED_SECTION_KEYS],
    );
    expect(eligible.rows).toHaveLength(2);
    for (const summary of eligible.rows) {
      expect(summary.required_count).toBe(5);
      expect(summary.added_bodies_blank).toBe(true);
    }
    const authored = await client.query(
      `SELECT body, display_order
         FROM discharge_summary_sections
        WHERE discharge_summary_id = $1::integer
          AND section_key = 'patient_guardian_instructions'`,
      [fixture.draftId],
    );
    expect(authored.rows[0]).toEqual({
      body: 'Preserve authored content',
      display_order: 2,
    });

    const protectedAfter = await client.query(
      `SELECT discharge_summary_id,
              jsonb_agg(to_jsonb(section) ORDER BY section.id) AS rows
         FROM discharge_summary_sections AS section
        WHERE section.discharge_summary_id = ANY($1::integer[])
        GROUP BY discharge_summary_id
        ORDER BY discharge_summary_id`,
      [protectedIds],
    );
    expect(protectedAfter.rows).toEqual(protectedBefore.rows);

    await expect(
      provisionInpatientDischargeSectionsTx(client, {
        tenantId: fixture.tenantId,
      }),
    ).resolves.toEqual({
      required_section_count: 5,
      templates_updated: 0,
      template_definitions_added: 0,
      unsigned_summaries_updated: 0,
      summary_sections_added: 0,
    });
  });
});
