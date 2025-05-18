// src/scripts/r2-list-files.js

const { listObjectsV2 } = require('../utils/r2Storage');
const dayjs = require('dayjs');

async function run() {
  console.log('📦 Listing all R2 bucket files with age info...\n');

  try {
    const files = await listObjectsV2();
    if (!files || files.length === 0) {
      console.log('No files found in R2 bucket.');
      return;
    }

    files.forEach(file => {
      const lastModified = dayjs(file.LastModified);
      const ageDays = dayjs().diff(lastModified, 'day');
      console.log(`🗂️ ${file.Key} (Age: ${ageDays} days, Size: ${file.Size} bytes, Last Modified: ${file.LastModified})`);
    });

    console.log(`\n✅ ${files.length} files listed.`);
  } catch (error) {
    console.error('❌ Failed to list R2 files:', error);
  }
}

run();
