const bcrypt = require('bcrypt');

async function generateNewPasswordHash() {
  // Provide the new password via environment variable: NEW_ADMIN_PASSWORD=... node reset-password.js
  const newPassword = process.env.NEW_ADMIN_PASSWORD;
  if (!newPassword) {
    console.error('Error: NEW_ADMIN_PASSWORD environment variable is required.');
    console.error('Usage: NEW_ADMIN_PASSWORD=<password> node reset-password.js');
    process.exit(1);
  }

  try {
    // Generate hash with 10 rounds (same as the existing hash)
    const hash = await bcrypt.hash(newPassword, 10);

    console.log('\n=== Password Reset Instructions ===\n');
    console.log('New Hash:', hash);

    console.log('\n1. Copy this SQL query:');
    console.log('----------------------------------------');
    console.log(`UPDATE admins SET password_hash = '${hash}' WHERE username = 'admin';`);
    console.log('----------------------------------------');

    console.log('\n2. Run it in pgAdmin 4:');
    console.log('   - Right-click on your database');
    console.log('   - Select "Query Tool"');
    console.log('   - Paste and execute the UPDATE query');
    console.log('   - You should see "Query returned successfully"');

    console.log('\n3. Test login with:');
    console.log('   Username: admin');
    console.log('   Password: (the value you passed via NEW_ADMIN_PASSWORD)');

  } catch (error) {
    console.error('Error generating hash:', error);
  }
}

generateNewPasswordHash();
