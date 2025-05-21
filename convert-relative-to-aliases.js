// convert-relative-to-aliases.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const aliases = {
  './utils/': '@utils/',
  './controllers/': '@controllers/',
  './routes/': '@routes/',
  './middleware/': '@middleware/',
  './logging/': '@logging/',
  './config/': '@config/',
  './scripts/': '@scripts/',
};

const srcDir = path.join(__dirname, 'src');

function restoreAliasesInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  for (const [relPath, alias] of Object.entries(aliases)) {
    if (content.includes(relPath)) {
      const updatedContent = content.replaceAll(
        new RegExp(`(['"])${relPath}`, 'g'),
        `$1${alias}`
      );
      if (updatedContent !== content) {
        content = updatedContent;
        modified = true;
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`↩️  Reverted imports in: ${filePath}`);
  }
}

function traverseDirectory(dir) {
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      traverseDirectory(fullPath);
    } else if (stat.isFile() && file.endsWith('.js')) {
      restoreAliasesInFile(fullPath);
    }
  }
}

console.log(`🔄 Starting relative-to-alias rollback in ${srcDir}`);
traverseDirectory(srcDir);
console.log('✅ Rollback complete.');
