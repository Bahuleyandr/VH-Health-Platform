import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYTICS_ROUTES = path.resolve(__dirname, '../../routes/analyticsRoutes.js');

describe('analytics routes failure semantics', () => {
  it('does not mask query failures with synthetic success payloads', () => {
    const source = fs.readFileSync(ANALYTICS_ROUTES, 'utf8');
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/fallback data/i);
    expect(source).not.toMatch(/success:\s*true[\s\S]{0,160}Mock data/i);
  });
});
