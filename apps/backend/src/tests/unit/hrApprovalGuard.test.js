// Regression guard for Sol Ultra audit #30/#36: the chart-side HR mount
// (hrRoutes) registered /overtime/:id/approve and /replacement/:id/hr-approve
// with NO authority guard, so any staff role in the block could approve another
// employee's overtime or give final replacement approval. The people-ops mount
// already gates these handlers with STAFF_LEAVE_WRITE; this test fails if either
// hrRoutes approval route loses its guard again.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.resolve(__dirname, '../../routes/staff/hrRoutes.js'), 'utf8');

// The routeMap entry for `route` — the array literal starting `['route'`.
function routeEntry(route) {
  const marker = `['${route}'`;
  const i = SRC.indexOf(marker);
  if (i === -1) throw new Error(`route ${route} not found in hrRoutes.js`);
  return SRC.slice(i, SRC.indexOf(']', i) + 1);
}

describe('HR approval authority guard (Sol Ultra #30/#36)', () => {
  for (const route of ['/overtime/:id/approve', '/replacement/:id/hr-approve']) {
    it(`${route} carries an authority guard, not just the handler`, () => {
      const entry = routeEntry(route);
      expect(entry).toContain('guardHrApprovalCollection');
    });
  }
});
