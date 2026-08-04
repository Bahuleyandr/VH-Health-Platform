import { envelope } from './_helpers.mjs';

export const schemas = {
  PatientAppConfig: {
    type: 'object',
    additionalProperties: false,
    required: ['min_patient_version_code'],
    properties: {
      min_patient_version_code: {
        type: 'integer',
        minimum: 0,
        example: 0,
        description: 'Minimum accepted patient app build number. 0 disables the hard upgrade gate.'
      },
      outage_communication: {
        type: 'object',
        additionalProperties: false,
        required: ['revision', 'messages', 'facility_contact_number'],
        description: 'Non-PHI C-D12 operational copy only. This is not a policy-delivery channel.',
        properties: {
          revision: {
            type: 'integer',
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER
          },
          messages: {
            type: 'object',
            additionalProperties: false,
            required: ['en', 'hi', 'ta', 'te', 'ml'],
            properties: Object.fromEntries(
              ['en', 'hi', 'ta', 'te', 'ml'].map(locale => [
                locale,
                {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000
                }
              ])
            )
          },
          facility_contact_number: {
            type: 'string',
            pattern: '^\\+?[0-9][0-9 ()-]{2,63}$'
          }
        }
      }
    }
  },

  PatientAppConfigResponse: envelope('PatientAppConfig'),

  EscalationRecipientRankMapping: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceKind', 'sourceValue', 'priorityRank'],
    properties: {
      id: { type: 'string', format: 'uuid', readOnly: true },
      sourceKind: { type: 'string', enum: ['position', 'designation'] },
      sourceValue: { type: 'string', minLength: 1, maxLength: 100 },
      priorityRank: { type: 'integer', minimum: 1, maximum: 100 }
    }
  },

  EscalationRecipientRankings: {
    type: 'object',
    additionalProperties: false,
    required: [
      'configured', 'explicitEmpty', 'revision', 'presenceWindowMinutes',
      'expectedMappingCount', 'mappings'
    ],
    properties: {
      configured: { type: 'boolean' },
      explicitEmpty: { type: 'boolean' },
      revision: { type: 'integer', minimum: 0 },
      presenceWindowMinutes: { type: 'integer', minimum: 15, maximum: 2880 },
      expectedMappingCount: { type: 'integer', minimum: 0, maximum: 500 },
      lastReplacedAt: { type: 'string', format: 'date-time', nullable: true },
      lastReplacedBy: { type: 'string', format: 'uuid', nullable: true },
      mappings: {
        type: 'array',
        maxItems: 500,
        items: { $ref: '#/components/schemas/EscalationRecipientRankMapping' }
      }
    }
  },

  ReplaceEscalationRecipientRankingsRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['mappings'],
    properties: {
      presenceWindowMinutes: { type: 'integer', minimum: 15, maximum: 2880, default: 720 },
      mappings: {
        type: 'array',
        maxItems: 500,
        items: { $ref: '#/components/schemas/EscalationRecipientRankMapping' }
      }
    }
  },

  EscalationRecipientRankingsResponse: envelope('EscalationRecipientRankings')
};

export const operations = {
  'GET /api/v1/config': {
    response: 'PatientAppConfigResponse'
  },
  'GET /api/v1/admin/tenants/{tenantId}/escalation-recipient-rankings': {
    description: 'Returns the tenant-owned escalation recipient ranking control state and mappings. The SUPER_ADMIN tenant-control mount requires MFA step-up and the admin IP allowlist. Never-configured and audited explicit-empty states are returned distinctly; both preserve legacy recipient ordering.',
    response: 'EscalationRecipientRankingsResponse'
  },
  'PUT /api/v1/admin/tenants/{tenantId}/escalation-recipient-rankings': {
    description: 'Atomically replaces the complete tenant-owned position/designation ranking map and presence window, updates the independently stored expected mapping count, and writes the before/after audit record in the same tenant-pinned transaction. An empty replacement is explicit and restores byte-exact legacy recipient ordering.',
    request: 'ReplaceEscalationRecipientRankingsRequest',
    response: 'EscalationRecipientRankingsResponse'
  }
};
