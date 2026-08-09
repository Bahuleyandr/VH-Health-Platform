export const operations = {
  'POST /api/v1/patient-flow/transport/tasks/{taskId}/verify': {
    summary: 'Verify a completed patient transport handoff',
    description:
      'Records receiving-staff verification after the assigned porter completes the transport. The completing porter cannot verify the same handoff.',
  },
};
