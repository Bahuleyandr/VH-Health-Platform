// Regression guard for Sol Ultra Wave-E (NICU): the PUT /nicu-chart-settings and
// PUT /nicu-score-definitions routes enable the tenant-wide feature / activate
// decision-support score definitions — clinical-governance actions that must be
// gated to leadership/admin, not any bedside ICU role (they were requireStaffOrAdmin).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '../../routes/clinical/icuRoutes.js'), 'utf8');

// The router.put(...) block whose args include `route` (a path can also have a
// GET route, so scan router.put( blocks specifically, not the first path match).
function putBlock(route) {
  let i = 0;
  while ((i = SRC.indexOf('router.put(', i)) !== -1) {
    const end = SRC.indexOf('\nrouter.', i + 1);
    const block = SRC.slice(i, end === -1 ? SRC.length : end);
    if (block.includes(`'${route}'`)) return block;
    i += 'router.put('.length;
  }
  throw new Error(`PUT ${route} not found`);
}

describe('NICU governance route authority (Sol Ultra Wave-E)', () => {
  for (const route of ['/nicu-chart-settings', '/nicu-score-definitions']) {
    it(`PUT ${route} is gated by requireGovernanceAuthority`, () => {
      expect(putBlock(route)).toContain('requireGovernanceAuthority');
    });
  }
});
