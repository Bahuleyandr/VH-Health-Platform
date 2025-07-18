const bcrypt = require('bcrypt');

async function generateNewPasswordHash() {
  // Set your new password here
  const newPassword = 'Admin@123'; // Change this to your desired password
  
  try {
    // Generate hash with 10 rounds (same as the existing hash)
    const hash = await bcrypt.hash(newPassword, 10);
    
    console.log('\n=== Password Reset Instructions ===\n');
    console.log('New Password:', newPassword);
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
    console.log('   Password:', newPassword);
    
  } catch (error) {
    console.error('Error generating hash:', error);
  }
}

generateNewPasswordHash();