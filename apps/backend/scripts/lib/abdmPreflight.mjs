export async function checkCanonicalAbhaDuplicates(client) {
  const { rows } = await client.query(
    `WITH duplicate_groups AS (
       SELECT count(*)::integer AS row_count
         FROM users
        WHERE abha_number IS NOT NULL
          AND btrim(abha_number) <> ''
        GROUP BY tenant_id, regexp_replace(abha_number, '-', '', 'g')
       HAVING count(*) > 1
     )
     SELECT count(*)::integer AS duplicate_groups,
            COALESCE(sum(row_count), 0)::integer AS duplicate_rows
       FROM duplicate_groups`,
  );
  return {
    duplicateGroups: Number(rows[0]?.duplicate_groups || 0),
    duplicateRows: Number(rows[0]?.duplicate_rows || 0),
  };
}
