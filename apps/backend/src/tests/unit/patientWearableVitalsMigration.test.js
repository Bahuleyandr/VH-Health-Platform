import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { splitStatements } from '../../utils/migrations/splitStatements.js';

const migrationPath = fileURLToPath(
  new URL('../../migrations/659_patient_wearable_vital_receipts.sql', import.meta.url),
);
const schemaPath = fileURLToPath(
  new URL('../../../prisma/schema.prisma', import.meta.url),
);
const migrationSql = readFileSync(migrationPath, 'utf8');
const prismaSchema = readFileSync(schemaPath, 'utf8');

describe('migration 659 patient wearable vital receipts', () => {
  test('uses the non-blocking runner contract and validates the additive receipt check', () => {
    expect(migrationSql).toContain('-- @no-transaction');
    expect(migrationSql).toContain('-- @statement_timeout: 0');
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT chk_patient_vitals_source_receipt_pair[\s\S]*?NOT VALID/i,
    );
    expect(migrationSql).toMatch(
      /VALIDATE CONSTRAINT chk_patient_vitals_source_receipt_pair/i,
    );
    expect(migrationSql).not.toMatch(
      /DROP CONSTRAINT IF EXISTS chk_patient_vitals_source_receipt_pair/i,
    );
  });

  test('repairs an interrupted concurrent index before recreating it', () => {
    const statements = splitStatements(migrationSql);
    const temporaryName = 'ux_patient_vitals_wearable_receipt_invalid_rebuild';
    const drops = statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => statement.includes(
        `DROP INDEX CONCURRENTLY IF EXISTS public.${temporaryName}`,
      ));
    const rename = statements.findIndex(
      statement => statement.includes('NOT indisvalid')
        && statement.includes('ux_patient_vitals_wearable_receipt')
        && statement.includes(`RENAME TO ${temporaryName}`),
    );
    const create = statements.findIndex(
      statement => statement.includes('CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS')
        && statement.includes('ux_patient_vitals_wearable_receipt'),
    );

    expect(drops).toHaveLength(2);
    expect(rename).toBeGreaterThan(drops[0].index);
    expect(drops[1].index).toBeGreaterThan(rename);
    expect(create).toBeGreaterThan(drops[1].index);
  });

  test('keeps Prisma receipt fields and the partial uniqueness contract in parity', () => {
    expect(prismaSchema).toMatch(/source_record_id\s+String\?\s+@db\.VarChar\(180\)/);
    expect(prismaSchema).toMatch(/source_record_hash\s+String\?\s+@db\.Char\(64\)/);
    expect(prismaSchema).toContain(
      '@@unique([tenant_id, patient_uid, source, source_record_id], map: "ux_patient_vitals_wearable_receipt", where: raw("(source_record_id IS NOT NULL)"))',
    );
  });
});
