// W5 S3 — persistent warning shown while a SUPER_ADMIN is acting inside another
// tenant. Renders nothing when not acting (the common case + every non-super
// admin), so it is a pure NO-OP for normal use.
'use client';

import { useActingTenant } from '@/contexts/ActingTenantContext';

export function ActingTenantBanner() {
  const { actingTenant, clear, isPending } = useActingTenant();
  if (!actingTenant) return null;

  return (
    <div
      role="alert"
      style={{
        background: '#7c2d12',
        color: '#fff',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 14,
      }}
    >
      <span>
        ⚠ Acting as tenant <strong>{actingTenant.slug || actingTenant.id}</strong> — every view
        and action applies to this tenant. This access is audited.
      </span>
      <button
        type="button"
        onClick={() => void clear()}
        disabled={isPending}
        style={{
          background: '#fff',
          color: '#7c2d12',
          border: 'none',
          borderRadius: 4,
          padding: '4px 12px',
          cursor: isPending ? 'wait' : 'pointer',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        Exit tenant
      </button>
    </div>
  );
}
