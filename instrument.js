const Sentry = require('@sentry/node');
const { Http, Express } = require('@sentry/integrations');

module.exports = (app) => {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    integrations: [
      new Http({ tracing: true }),
      new Express({ app }),
    ],
    tracesSampleRate: 1.0,
  });

  return Sentry;
};
