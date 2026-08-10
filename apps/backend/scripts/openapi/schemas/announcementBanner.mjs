// apps/backend/scripts/openapi/schemas/announcementBanner.mjs
// Hospital-wide admin-portal announcement banner (ADM-2), persisted in
// tenants.settings.announcementBanner and served from
// /api/v1/notifications/announcement-banner.
import { envelope } from './_helpers.mjs';

export const schemas = {
  AnnouncementBanner: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'type', 'enabled'],
    properties: {
      text: {
        type: 'string',
        maxLength: 300,
        description: 'Sanitized banner text; empty when no banner is configured.',
      },
      type: {
        type: 'string',
        enum: ['info', 'warning', 'critical', 'success'],
        description: 'Visual style of the banner.',
      },
      enabled: {
        type: 'boolean',
        description: 'Whether the banner is currently shown to portal users.',
      },
      updated_at: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'When the banner was last saved; used for per-user dismissal.',
      },
    },
  },

  AnnouncementBannerPayload: {
    type: 'object',
    required: ['banner'],
    properties: {
      banner: {
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/AnnouncementBanner' }],
      },
    },
  },

  AnnouncementBannerUpdateRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['text', 'type', 'enabled'],
    properties: {
      text: { type: 'string', maxLength: 300 },
      type: { type: 'string', enum: ['info', 'warning', 'critical', 'success'] },
      enabled: { type: 'boolean' },
    },
  },

  AnnouncementBannerResponse: envelope('AnnouncementBannerPayload'),
};

export const operations = {
  'GET /api/v1/notifications/announcement-banner': {
    description:
      'Returns the tenant-wide announcement banner shown across the admin portal dashboard, or a null banner when none is configured. ADMIN or SUPER_ADMIN only.',
    response: 'AnnouncementBannerResponse',
  },
  'PUT /api/v1/notifications/announcement-banner': {
    description:
      'Saves the tenant-wide announcement banner. Requires SUPER_ADMIN or an active ADMIN with notificationManagement. The text is sanitized and capped at 300 characters; saving with enabled=false or empty text hides the banner for all portal users. The change is audit-logged.',
    request: 'AnnouncementBannerUpdateRequest',
    response: 'AnnouncementBannerResponse',
  },
};
