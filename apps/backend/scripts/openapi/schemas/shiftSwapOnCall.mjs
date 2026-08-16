// apps/backend/scripts/openapi/schemas/shiftSwapOnCall.mjs
// Shift-for-shift swap requests + the dedicated on-call roster (migration
// 682), served from /api/v1/staff/roster-board/swaps* and
// /api/v1/staff/roster-board/*on-call*.
import { envelope, listEnvelope } from './_helpers.mjs';

export const schemas = {
  ShiftSwapRequest: {
    type: 'object',
    required: ['id', 'department', 'requester_id', 'counterparty_id', 'status'],
    properties: {
      id: { type: 'integer' },
      department: { type: 'string' },
      requester_id: { type: 'integer' },
      requester_uid: { type: 'string', format: 'uuid', nullable: true },
      requester_name: { type: 'string', nullable: true },
      requester_assignment_id: { type: 'integer' },
      requester_roster_date: { type: 'string', format: 'date', nullable: true },
      requester_shift_label: { type: 'string', nullable: true },
      requester_shift_start: { type: 'string', nullable: true },
      requester_shift_end: { type: 'string', nullable: true },
      counterparty_id: { type: 'integer' },
      counterparty_uid: { type: 'string', format: 'uuid', nullable: true },
      counterparty_name: { type: 'string', nullable: true },
      counterparty_assignment_id: { type: 'integer' },
      counterparty_roster_date: { type: 'string', format: 'date', nullable: true },
      counterparty_shift_label: { type: 'string', nullable: true },
      counterparty_shift_start: { type: 'string', nullable: true },
      counterparty_shift_end: { type: 'string', nullable: true },
      status: {
        type: 'string',
        enum: [
          'proposed', 'counterparty_accepted', 'counterparty_declined',
          'approved', 'rejected', 'cancelled', 'expired',
        ],
      },
      reason: { type: 'string', nullable: true },
      counterparty_note: { type: 'string', nullable: true },
      counterparty_responded_at: { type: 'string', format: 'date-time', nullable: true },
      decided_by: { type: 'integer', nullable: true },
      decided_by_name: { type: 'string', nullable: true },
      decided_at: { type: 'string', format: 'date-time', nullable: true },
      decision_notes: { type: 'string', nullable: true },
      expires_at: { type: 'string', format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  ShiftSwapProposeRequest: {
    type: 'object',
    required: ['requester_assignment_id', 'counterparty_assignment_id'],
    properties: {
      requester_assignment_id: {
        type: 'integer',
        description: 'The requester\'s own published staff_shift_roster_assignments row being offered.',
      },
      counterparty_assignment_id: {
        type: 'integer',
        description: 'The colleague\'s published assignment (same department) the requester wants in exchange.',
      },
      reason: { type: 'string', nullable: true },
    },
  },

  ShiftSwapRespondRequest: {
    type: 'object',
    required: ['decision'],
    properties: {
      decision: { type: 'string', enum: ['accept', 'decline'] },
      note: { type: 'string', nullable: true },
    },
  },

  ShiftSwapReviewRequest: {
    type: 'object',
    required: ['decision'],
    properties: {
      decision: { type: 'string', enum: ['approved', 'rejected'] },
      notes: { type: 'string', nullable: true },
    },
  },

  OnCallAssignment: {
    type: 'object',
    required: ['id', 'department', 'tier', 'staff_id', 'start_at', 'end_at', 'is_active'],
    properties: {
      id: { type: 'integer' },
      department: { type: 'string' },
      specialty: { type: 'string', nullable: true },
      tier: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: '1 = primary on call, 2 = secondary/backup, 3+ = further escalation tiers.',
      },
      staff_id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      staff_role: { type: 'string', nullable: true },
      staff_name: { type: 'string', nullable: true },
      staff_phone: { type: 'string', nullable: true },
      start_at: { type: 'string', format: 'date-time' },
      end_at: { type: 'string', format: 'date-time' },
      is_active: { type: 'boolean' },
      notes: { type: 'string', nullable: true },
      created_by: { type: 'integer', nullable: true },
      created_by_name: { type: 'string', nullable: true },
      ended_at: { type: 'string', format: 'date-time', nullable: true },
      end_reason: { type: 'string', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  OnCallCreateRequest: {
    type: 'object',
    required: ['staff_id', 'start_at', 'end_at'],
    properties: {
      staff_id: { type: 'integer' },
      specialty: { type: 'string', nullable: true },
      tier: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
      start_at: { type: 'string', format: 'date-time' },
      end_at: { type: 'string', format: 'date-time' },
      notes: { type: 'string', nullable: true },
    },
  },

  OnCallEndRequest: {
    type: 'object',
    properties: {
      reason: { type: 'string', nullable: true },
    },
  },

  SwapCandidate: {
    type: 'object',
    required: ['assignment_id', 'staff_id', 'department', 'roster_date', 'shift_label'],
    properties: {
      assignment_id: { type: 'integer' },
      staff_id: { type: 'integer' },
      staff_uid: { type: 'string', format: 'uuid', nullable: true },
      staff_name: { type: 'string', nullable: true },
      staff_role: { type: 'string', nullable: true },
      department: { type: 'string' },
      roster_date: { type: 'string', format: 'date' },
      shift_label: { type: 'string' },
      shift_start: { type: 'string', nullable: true },
      shift_end: { type: 'string', nullable: true },
      assignment_target_label: { type: 'string', nullable: true },
    },
  },

  ShiftSwapResponse: envelope('ShiftSwapRequest'),
  SwapCandidateListResponse: listEnvelope('SwapCandidate'),
  ShiftSwapListResponse: listEnvelope('ShiftSwapRequest'),
  OnCallAssignmentResponse: envelope('OnCallAssignment'),
  OnCallAssignmentListResponse: listEnvelope('OnCallAssignment'),
};

export const operations = {
  'POST /api/v1/staff/roster-board/swaps': {
    description:
      'Proposes a shift-for-shift swap: the requester offers one of their own published roster assignments and names a colleague\'s published assignment in the same department. Both shifts must be in the future; the request expires when the earlier shift starts. The colleague is notified in-app.',
    request: 'ShiftSwapProposeRequest',
    response: 'ShiftSwapResponse',
  },
  'GET /api/v1/staff/roster-board/swaps/my': {
    description:
      'Lists the authenticated staff member\'s shift swap requests — both those they proposed and those proposed to them — with both shifts\' roster context, live requests first.',
    response: 'ShiftSwapListResponse',
  },
  'GET /api/v1/staff/roster-board/swaps/candidates': {
    description:
      'Published future assignments of colleagues in the requester\'s own roster department — the pick-list for proposing a swap. Excludes rows that already carry a live swap request.',
    response: 'SwapCandidateListResponse',
  },
  'GET /api/v1/staff/roster-board/departments/{department}/swaps': {
    description:
      'Lists a department\'s shift swap requests for reviewers (the same authority that reviews duty preference and coverage requests), counterparty-accepted requests first. Optional status filter.',
    response: 'ShiftSwapListResponse',
  },
  'POST /api/v1/staff/roster-board/swaps/{id}/respond': {
    description:
      'Counterparty accept/decline of a proposed shift swap. Only the invited colleague can respond; acceptance moves the request to counterparty_accepted and hands it to the department reviewer.',
    request: 'ShiftSwapRespondRequest',
    response: 'ShiftSwapResponse',
  },
  'POST /api/v1/staff/roster-board/swaps/{id}/cancel': {
    description:
      'Requester withdrawal of a still-live shift swap request. The counterparty is notified.',
    response: 'ShiftSwapResponse',
  },
  'POST /api/v1/staff/roster-board/swaps/{id}/review': {
    description:
      'Department reviewer decision. Approval requires prior counterparty acceptance and atomically exchanges the two roster assignment rows (person fields only — slot targets and lead flags stay with the slot) in one transaction with audit rows on both boards; both parties are notified. Rejection is allowed from proposed or counterparty_accepted.',
    request: 'ShiftSwapReviewRequest',
    response: 'ShiftSwapResponse',
  },
  'GET /api/v1/staff/roster-board/on-call/my': {
    description:
      'Lists the authenticated staff member\'s current and upcoming on-call stints (active rows ending within the last 7 days or later).',
    response: 'OnCallAssignmentListResponse',
  },
  'GET /api/v1/staff/roster-board/on-call/now': {
    description:
      'Who is on call right now (or at an optional `at` instant) — active on-call assignments covering the instant, optionally filtered by department and tier. The escalation engine consults the same table to order notification recipients.',
    response: 'OnCallAssignmentListResponse',
  },
  'GET /api/v1/staff/roster-board/departments/{department}/on-call': {
    description:
      'Lists a department\'s on-call roster for its roster managers; active/upcoming stints by default, full history with include_ended=true.',
    response: 'OnCallAssignmentListResponse',
  },
  'POST /api/v1/staff/roster-board/departments/{department}/on-call': {
    description:
      'Creates an on-call stint (department roster managers only). The staff member must hold one of the department\'s roster staff roles; overlapping active stints for the same department/specialty/tier are rejected by a database exclusion constraint. The staff member is notified in-app.',
    request: 'OnCallCreateRequest',
    response: 'OnCallAssignmentResponse',
  },
  'POST /api/v1/staff/roster-board/on-call/{id}/end': {
    description:
      'Ends an on-call stint early (soft end: the row keeps ended-by/at evidence and stops counting as active for who-is-on-call and escalation ordering).',
    request: 'OnCallEndRequest',
    response: 'OnCallAssignmentResponse',
  },
};
