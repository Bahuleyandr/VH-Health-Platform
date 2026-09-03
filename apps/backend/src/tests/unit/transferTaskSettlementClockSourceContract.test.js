import { readFileSync } from 'node:fs';

const serviceSource = readFileSync(
  new URL('../../services/workflow/taskService.js', import.meta.url),
  'utf8',
);

function functionSource(name, nextAnchor) {
  const start = serviceSource.indexOf(`export async function ${name}(`);
  const end = serviceSource.indexOf(nextAnchor, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return serviceSource.slice(start, end);
}

describe('transfer task settlement database clock contract', () => {
  const settlements = [
    {
      name: 'covering transfer',
      source: functionSource(
        'settleCoveringTransferReviewTaskTx',
        'export async function settleOpInpatientTransferReviewTaskTx(',
      ),
      timestampParameter: '$4',
      timestampColumns: ['completed_at', 'cancelled_at'],
      metadataKey: 'covering_transfer_settled_at',
    },
    {
      name: 'OP-to-inpatient transfer',
      source: functionSource(
        'settleOpInpatientTransferReviewTaskTx',
        'export async function settleEdDestinationHandoffReviewTaskTx(',
      ),
      timestampParameter: '$3',
      timestampColumns: ['completed_at'],
      metadataKey: 'op_inpatient_transfer_settled_at',
    },
    {
      name: 'ED destination handoff',
      source: functionSource(
        'settleEdDestinationHandoffReviewTaskTx',
        '// Role codes a task may be (re)assigned to.',
      ),
      timestampParameter: '$4',
      timestampColumns: ['completed_at', 'cancelled_at'],
      metadataKey: 'ed_destination_handoff_settled_at',
    },
  ];

  it.each(settlements)(
    '$name uses one post-lock PostgreSQL instant for every settlement field',
    ({ source, timestampParameter, timestampColumns, metadataKey }) => {
      expect(source).toMatch(
        /to_char\(\s*GREATEST\(clock_timestamp\(\), (?:chi|handoff)\.requested_at\) AT TIME ZONE 'UTC',\s*'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\s*\) AS settlement_clock/,
      );
      expect(source).toContain('const settledAt = bindings[0].settlement_clock;');
      expect(source).not.toContain('const settledAt = new Date().toISOString();');

      const settlementQuery = source.match(
        /const rows = await tx\.\$queryRawUnsafe\(\s*`[\s\S]*?RETURNING \$\{TASK_RETURNING\}`,\s*([\s\S]*?)\n {2}\);/,
      );
      expect(settlementQuery).not.toBeNull();
      const queryArguments = settlementQuery[1]
        .split(',')
        .map((argument) => argument.trim())
        .filter(Boolean);
      expect(queryArguments[Number(timestampParameter.slice(1)) - 1]).toBe('settledAt');
      expect(queryArguments.filter((argument) => argument === 'settledAt')).toHaveLength(1);
      for (const column of timestampColumns) {
        expect(source).toMatch(
          new RegExp(`${column}\\s*=[\\s\\S]{0,100}\\${timestampParameter}::timestamptz`),
        );
      }
      expect(source).toContain(`'${metadataKey}', ${timestampParameter}::text`);
      expect(source).toContain(`updated_at = ${timestampParameter}::timestamptz`);
    },
  );
});
