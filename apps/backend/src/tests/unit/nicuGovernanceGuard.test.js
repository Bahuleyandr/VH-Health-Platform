// Regression guard for Sol Ultra Wave-E (NICU): the PUT /nicu-chart-settings and
// PUT /nicu-score-definitions routes enable the tenant-wide feature / activate
// decision-support score definitions — clinical-governance actions that must be
// gated to leadership/admin, not any bedside ICU role (they were requireStaffOrAdmin).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(__dirname, '../../routes/clinical/icuRoutes.js'), 'utf8');

// The router.put(...) block that registers `route` (from the router.put before it
// to the next router. call), so we can assert its middleware.
function putBlock(route) {
  const pos = SRC.indexOf(`'${route}'`);
  if (pos === -1) throw new Error(`route ${route} not found`);
  const start = SRC.lastIndexOf('router.put(', pos);
  if (start === -1) throw new Error(`${route} is not a router.put route`);
  const nextCall = SRC.indexOf('\nrouter.', pos);
  return SRC.slice(start, nextCall === -1 ? pos + 400 : nextCall);
}

describe('NICU governance route authority (Sol Ultra Wave-E)', () => {
  for (const route of ['/nicu-chart-settings', '/nicu-score-definitions']) {
    it(`PUT ${route} is gated by requireGovernanceAuthority`, () => {
      expect(putBlock(route)).toContain('requireGovernanceAuthority');
    });
  }
});
