// controllers/feedbackController.js
const logger = require('../logger');
const { success, error } = require('../responseHelper');

exports.submitFeedback = async (req, res) => {
  const { phoneNumber, rating, comment } = req.body;

  if (!phoneNumber || !rating) {
    return res.status(400).json({ error: 'phoneNumber and rating are required' });
  }

  try {
    // Replace this block with database logic if you want to persist feedback
    logger.info(`Feedback received from ${phoneNumber}: Rating ${rating}, Comment: ${comment || 'None'}`);

    success(res, { phoneNumber, rating, comment }, 'Feedback received');
  } catch (err) {
    logger.error(err.stack || err.toString());
    error(res, 'Failed to process feedback');
  }
};
