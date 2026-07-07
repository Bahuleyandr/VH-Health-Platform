import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'tests', 'scripts'];
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    if (st.isFile() && p.endsWith('.js')) files.push(p);
  }
}

for (const root of roots) walk(root);
for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`Checked ${files.length} JavaScript files`);
