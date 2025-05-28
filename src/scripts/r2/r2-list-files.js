// src/scripts/r2-list-files.js

import { listObjectsV2 } from '../../utils/r2Storage.js';
import dayjs from 'dayjs';

async function run() {
  console.log('📦 Listing all R2 bucket files with age info...\n');

  try {
    const filesPage = await listObjectsV2();
    const files = filesPage.Contents || [];

    if (files.length === 0) {
      console.log('No files found in R2 bucket.');
      return;
    }

    files.forEach((file) => {
      const lastModified = dayjs(file.LastModified);
      const ageDays = dayjs().diff(lastModified, 'day');
      console.log(
        `🗂️ ${file.Key} (Age: ${ageDays} days, Size: ${file.Size} bytes, Last Modified: ${file.LastModified})`,
      );
    });

    console.log(`\n✅ ${files.length} files listed.`);
  } catch (error) {
    console.error('❌ Failed to list R2 files:', error);
  }
}

run();
