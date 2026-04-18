import fetch from 'node-fetch';
import logger from '../logging/logger.js';

const CLAMAV_URL = process.env.CLAMAV_API_URL || 'http://localhost:3000/scan';
const CLAMAV_API_KEY = process.env.CLAMAV_API_KEY;

export async function scanFileWithClamAV(fileUrl) {
  try {
    const response = await fetch(CLAMAV_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': CLAMAV_API_KEY
      },
      body: JSON.stringify({ fileUrl })
    });

    if (!response.ok) {
      logger.warn(`ClamAV scan failed for ${fileUrl}, status: ${response.status}`);
      return { status: 'error', error: 'Scan API failed' };
    }

    const result = await response.json();
    return result;
  } catch (error) {
    logger.error(`Error scanning file with ClamAV: ${error.message}`);
    return { status: 'error', error: error.message };
  }
}
