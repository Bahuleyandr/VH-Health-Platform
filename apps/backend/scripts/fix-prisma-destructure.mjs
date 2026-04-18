import logger from '../src/logging/logger.js';
import fs from 'fs';
import { execSync } from 'child_process';

// Find every file under src/ that has the problematic pattern
const listing = execSync(
  `grep -rlE "const \\{ rows[^}]*\\} = await prisma\\.\\$queryRaw" src/`,
  { encoding: 'utf8' }
).trim().split('\n').filter(Boolean);

logger.info('Scanning', listing.length, 'files');

let total = 0;
const results = [];
for (const f of listing) {
  const src = fs.readFileSync(f, 'utf8');
  // Two patterns: `{ rows }` and `{ rows: alias }`
  let out = src;
  let fileTotal = 0;

  const reAlias = /const \{ rows: (\w+) \} = await prisma\.\$queryRaw/g;
  out = out.replace(reAlias, (_m, name) => {
    fileTotal++;
    return `const ${name} = await prisma.$queryRaw`;
  });

  const rePlain = /const \{ rows \} = await prisma\.\$queryRaw/g;
  out = out.replace(rePlain, () => {
    fileTotal++;
    return 'const rows = await prisma.$queryRaw';
  });

  if (fileTotal > 0) {
    fs.writeFileSync(f, out);
    results.push(`${f} → ${fileTotal}`);
    total += fileTotal;
  }
}
results.sort().forEach((r) => logger.info(r));
logger.info('TOTAL:', total);
