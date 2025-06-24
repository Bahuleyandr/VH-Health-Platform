// convert-aliases-to-relative.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const aliases = {
  '@utils/': './utils/',
  '@controllers/': './controllers/',
  '@routes/': './routes/',
  '@middleware/': './middleware/',
  '@logging/': './logging/',
  '@config/': './config/',
  '@scripts/': './scripts/',
};

const srcDir = path.join(__dirname, 'src');

function replaceAliasesInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let modified = false;

  for (const [alias, relPath] of Object.entries(aliases)) {
    if (content.includes(alias)) {
      const updatedContent = content.replaceAll(
        new RegExp(`(['"])${alias}`, 'g'),
        `$1${relPath}`
      );
      if (updatedContent !== content) {
        content = updatedContent;
        modified = true;
      }
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Updated imports in: ${filePath}`);
  }
}

function traverseDirectory(dir) {
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      traverseDirectory(fullPath);
    } else if (stat.isFile() && file.endsWith('.js')) {
      replaceAliasesInFile(fullPath);
    }
  }
}

console.log(`🔄 Starting alias-to-relative import refactor in ${srcDir}`);
traverseDirectory(srcDir);
console.log('✅ Refactoring complete.');
