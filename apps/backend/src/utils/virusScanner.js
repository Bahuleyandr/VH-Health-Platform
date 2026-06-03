import clamav from 'clamav.js';
import { PassThrough } from 'stream';

/**
 * Scan a buffer with ClamAV
 * @param {Buffer} buffer
 * @returns {Promise<void>}
 */
export function scanBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const readable = new PassThrough();
    readable.end(buffer);

    clamav.ping(3310, '127.0.0.1', 1000, err => {
      if (err) {return reject(new Error('ClamAV not reachable'));}

      clamav.createScanner(3310, '127.0.0.1').scan(readable, (err, object, malicious) => {
        if (err) {return reject(err);}
        if (malicious) {return reject(new Error(`Virus detected: ${malicious}`));}
        resolve();
      });
    });
  });
}
