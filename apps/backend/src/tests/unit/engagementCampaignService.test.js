import { AppError } from '../../utils/AppError.js';
import {
  normalizeAllowedVariables,
  renderTemplateString,
  sanitizeTemplateVariables,
} from '../../services/engagement/engagementCampaignService.js';
import { resolveChannelsForOutboxRow } from '../../utils/notifications/tenantNotificationChannels.js';

describe('engagement campaign safety helpers', () => {
  it('allows only neutral template variables for outbound engagement copy', () => {
    expect(normalizeAllowedVariables(['first_name', 'appointment_window', 'support_phone'])).toEqual([
      'first_name',
      'appointment_window',
      'support_phone',
    ]);
  });

  it('blocks PHI-shaped template variables and values', () => {
    expect(() => normalizeAllowedVariables(['diagnosis'])).toThrow(AppError);
    expect(() => sanitizeTemplateVariables(
      { first_name: 'Asha', appointment_window: 'HbA1c result is high' },
      ['first_name', 'appointment_window'],
    )).toThrow(AppError);
  });

  it('renders only approved placeholders into the provider-bound body', () => {
    const variables = sanitizeTemplateVariables(
      { first_name: 'Asha', appointment_window: 'tomorrow morning' },
      ['first_name', 'appointment_window'],
    );

    expect(renderTemplateString('Hi {{ first_name }}, visit {{appointment_window}}.', variables))
      .toBe('Hi Asha, visit tomorrow morning.');
  });

  it('lets an engagement outbox row explicitly select the existing delivery channel', () => {
    const decision = resolveChannelsForOutboxRow({
      type: 'engagement_campaign',
      recipient_id: '42',
      recipient_phone: '+919000000001',
      payload: { channels: ['whatsapp'] },
    }, {});

    expect(decision).toEqual({
      channels: ['whatsapp'],
      preferenceKey: 'engagement_campaign',
      source: 'tenant',
    });
  });
});
