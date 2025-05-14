#!/usr/bin/env node

// Load environment variables
require('dotenv').config();

// Import the configured Express app
const app = require('../app');

// Determine the port to listen on
const PORT = process.env.PORT || 5000;

// Start the server
app.listen(PORT, () => {
  console.log(`VH Health Backend running on port ${PORT}`);
});
