const clamav = require('clamav.js');

/**
 * Scans a buffer using ClamAV.
 * @param {Buffer} buffer - File buffer to scan.
 * @returns {Promise<void>} - Resolves if clean, rejects if infected.
 */
exports.scanBuffer = (buffer) => {
  return new Promise((resolve, reject) => {
    clamav.ping(3310, 'localhost', 1000, (err) => {
      if (err) return reject(new Error('ClamAV not reachable'));
      
      clamav.createScanner(3310, 'localhost').scan(buffer, (err, object, malicious) => {
        if (err) return reject(err);
        if (malicious) return reject(new Error(`Malware detected: ${malicious}`));
        resolve();
      });
    });
  });
};
