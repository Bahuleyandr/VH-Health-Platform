// src/scripts/backup-db.js
import { execSync } from 'child_process';

try {
  console.log('⏳ Running PostgreSQL backup...');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}.sql`;
  const cmd = `pg_dump ${process.env.DATABASE_URL} > backups/${filename}`;

  execSync(cmd, { stdio: 'inherit', shell: true });

  console.log(`✅ Backup completed: backups/${filename}`);
  process.exit(0);
} catch (err) {
  console.error('❌ Backup failed:', err.message);
  process.exit(1);
}
