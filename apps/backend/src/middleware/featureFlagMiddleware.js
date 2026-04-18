import { isEnabled } from '../services/featureFlags/featureFlagService.js';

/**
 * Middleware factory that gates a route behind a feature flag.
 * Returns 404 "Feature not available" if the flag is disabled for the requesting user.
 *
 * @param {string} flagName
 * @returns {Function} Express middleware
 */
export function requireFeature(flagName) {
  return async (req, res, next) => {
    const userContext = req.user ? { role: req.user.role, id: req.user.id } : null;
    const enabled = await isEnabled(flagName, userContext);

    if (!enabled) {
      return res.status(404).json({
        success: false,
        message: 'Feature not available',
      });
    }

    next();
  };
}
