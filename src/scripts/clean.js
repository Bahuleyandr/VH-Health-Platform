// scripts/clean.js
// Cross-platform cleaning script that works on Windows, Mac, and Linux

const fs = require('fs');
const path = require('path');

// Directories and files to clean
const itemsToClean = [
  'node_modules',
  '.next',
  'package-lock.json',
  '.turbo',
  'dist',
  'build'
];

console.log('🧹 Starting cleanup process...\n');

function deleteRecursive(targetPath) {
  if (fs.existsSync(targetPath)) {
    if (fs.lstatSync(targetPath).isDirectory()) {
      console.log(`📁 Removing directory: ${targetPath}`);
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      console.log(`📄 Removing file: ${targetPath}`);
      fs.unlinkSync(targetPath);
    }
    return true;
  }
  return false;
}

let cleanedCount = 0;

itemsToClean.forEach(item => {
  const itemPath = path.join(process.cwd(), item);
  if (deleteRecursive(itemPath)) {
    cleanedCount++;
  }
});

if (cleanedCount === 0) {
  console.log('✨ Already clean! No items to remove.');
} else {
  console.log(`\n✅ Cleanup complete! Removed ${cleanedCount} items.`);
}

console.log('\n📦 You can now run "npm install" to reinstall dependencies.');