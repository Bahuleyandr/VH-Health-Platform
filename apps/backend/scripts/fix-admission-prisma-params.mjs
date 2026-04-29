import logger from '../src/logging/logger.js';
import fs from 'fs';

const f = 'src/services/emr/admissionService.js';
const s = fs.readFileSync(f, 'utf8');

// Fix prisma.$queryRawUnsafe(`sql`, [arg1, arg2]) -> prisma.$queryRawUnsafe(`sql`, arg1, arg2)
const re = /(prisma\.\$queryRawUnsafe\(\s*`[^`]+`\s*,)\s*\[([^\]]+)\]\s*\)/g;
let count = 0;
const out = s.replace(re, (_m, lead, inner) => {
  count++;
  return `${lead} ${inner.trim()})`;
});

fs.writeFileSync(f, out);
logger.info('fixed', count, 'sites in', f);
