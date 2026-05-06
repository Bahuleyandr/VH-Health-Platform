import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../..');
const SCANNED_DIRS = ['controllers', 'services'];
const LEGACY_PAGINATION_PATTERNS = [
  /\bcurrentPage\b/,
  /\btotal_pages\b/,
  /\bpages:\s*pagination\.totalPages\b/,
  /\btotalPages:\s*pagination\.totalPages\b/,
];

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('backend list pagination response shape', () => {
  it('does not reintroduce legacy pagination aliases in list controllers/services', () => {
    const offenders = [];
    for (const relativeDir of SCANNED_DIRS) {
      for (const file of walk(path.join(SRC_ROOT, relativeDir))) {
        const text = fs.readFileSync(file, 'utf8');
        for (const pattern of LEGACY_PAGINATION_PATTERNS) {
          if (pattern.test(text)) {
            offenders.push(`${path.relative(SRC_ROOT, file)} -> ${pattern}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
