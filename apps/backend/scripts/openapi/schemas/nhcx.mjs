export const operations = {
  'POST /api/v1/admin/nhcx/messages/{id}/claim-stranded-inbound': {
    description:
      'Authenticated ADMIN or step-up-authenticated SUPER_ADMIN operators may claim a stale inbound NHCX callback for owner-directed review within the request tenant. The claim records recovery ownership and disposition without replaying the callback or invoking NHCX domain, dispatch, redrive, or payment processing.',
  },
};
