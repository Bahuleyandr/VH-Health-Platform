import { envelope } from './_helpers.mjs';

export const schemas = {
  PatientAppConfig: {
    type: 'object',
    additionalProperties: false,
    required: ['min_patient_version_code', 'min_staff_version_code'],
    properties: {
      min_patient_version_code: {
        type: 'integer',
        minimum: 0,
        example: 0,
        description: 'Legacy projection of the signed minimum-version policy for older clients. 0 disables the hard upgrade gate when no signed policy is present.'
      },
      min_staff_version_code: {
        type: 'integer',
        minimum: 0,
        example: 0,
        description: 'Staff app hard-upgrade gate (MIN_STAFF_VERSION_CODE). 0 disables the gate. Unsigned by design: the staff client uses the legacy comparison only and fails open when this endpoint is unreachable.'
      },
      minimum_version_policy: {
        type: 'object',
        additionalProperties: false,
        required: ['algorithm', 'format', 'key_id', 'policy', 'signature'],
        description: 'Operator-provided Ed25519 envelope. The backend validates and forwards this value but never signs or rewrites it.',
        properties: {
          algorithm: { type: 'string', enum: ['Ed25519'] },
          format: {
            type: 'string',
            enum: ['vhhealth_patient_minimum_version/v1']
          },
          key_id: {
            type: 'string',
            pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          },
          policy: {
            type: 'object',
            additionalProperties: false,
            required: [
              'audience',
              'tenant_id',
              'revision',
              'min_patient_version_code',
              'issued_at',
              'grace_until'
            ],
            properties: {
              audience: {
                type: 'string',
                enum: ['vhhealth-patient-minimum-version']
              },
              tenant_id: { type: 'string', format: 'uuid' },
              revision: {
                type: 'integer',
                minimum: 1,
                maximum: Number.MAX_SAFE_INTEGER
              },
              min_patient_version_code: {
                type: 'integer',
                minimum: 0,
                maximum: Number.MAX_SAFE_INTEGER
              },
              issued_at: { type: 'string', format: 'date-time' },
              grace_until: {
                type: 'string',
                format: 'date-time',
                description: 'Signed grace deadline, bounded by the route to no more than seven days after issued_at.'
              }
            }
          },
          signature: {
            type: 'string',
            minLength: 88,
            maxLength: 88,
            description: 'Canonical base64 Ed25519 signature over the RFC 8785 canonical envelope without this field.'
          }
        }
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
