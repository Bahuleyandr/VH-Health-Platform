const express = require('express');
const router = express.Router();

router.get('/debug-sentry', (req, res) => {
  throw new Error('My first Sentry error!');
});

module.exports = router;
