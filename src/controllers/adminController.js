const { executeCleanup } = require('../utils/r2CleanupJob');
const { listObjectsV2 } = require('../utils/r2Storage');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ✅ List R2 Files
exports.listR2Files = async (req, res) => {
  try {
    const files = await listObjectsV2();
    res.json({ success: true, files });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Cleanup R2 Files
exports.cleanupR2Files = async (req, res) => {
  try {
    await executeCleanup();
    res.json({ success: true, message: 'R2 cleanup executed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Migrate R2 Archive
exports.migrateR2Archive = (req, res) => {
  try {
    execSync('npm run r2:migrate-archive', { stdio: 'inherit' });
    res.json({ success: true, message: 'R2 archive migration triggered.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Backup Database
exports.backupDatabase = (req, res) => {
  try {
    execSync('npm run db:backup', { stdio: 'inherit' });
    res.json({ success: true, message: 'Database backup triggered.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Restore Database
exports.restoreDatabase = (req, res) => {
  try {
    execSync('npm run db:restore', { stdio: 'inherit' });
    res.json({ success: true, message: 'Database restore triggered.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ List Logs
exports.listLogs = (req, res) => {
  const logDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logDir)) {
    return res.json({ success: true, logs: [] });
  }

  const files = fs.readdirSync(logDir);
  res.json({ success: true, logs: files });
};

// ✅ Cleanup Logs
exports.cleanupLogs = (req, res) => {
  try {
    execSync('npm run logs:cleanup', { stdio: 'inherit' });
    res.json({ success: true, message: 'Logs cleanup executed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Purge Logs
exports.purgeLogs = (req, res) => {
  try {
    execSync('npm run logs:purge', { stdio: 'inherit' });
    res.json({ success: true, message: 'Logs purged.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Fix Permissions
exports.fixPermissions = (req, res) => {
  try {
    execSync('npm run fix:permissions', { stdio: 'inherit' });
    res.json({ success: true, message: 'Permissions fixed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// ✅ Validate Swagger
exports.validateSwagger = (req, res) => {
  try {
    execSync('npm run swagger:validate', { stdio: 'inherit' });
    res.json({ success: true, message: 'Swagger validation completed.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
