const Sentry = require("@sentry/node");

Sentry.init({
  dsn: "https://9e3749902b4c395c970fe3421de3d7c3@o4509318211239936.ingest.us.sentry.io/4509318237650944",
  tracesSampleRate: 1.0,
  sendDefaultPii: true,
});

module.exports = {
  Sentry,
  Handlers: {
    errorHandler: Sentry.Handlers.errorHandler()
  }
};
