export const operations = {
  'POST /api/v1/devices/notification-authority/validate': {
    summary: 'Validate the current notification delivery authority',
    description:
      'Fail-closed authorization check used before a Staff client presents a Code Blue push. ' +
      'The authenticated tenant, recipient, access session, device registration epoch, session ' +
      'family, and authorization epoch must still match the server-owned notification binding.',
  },
};
