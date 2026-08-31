// src/services/pharmacy/orderService.js
// Legacy pharmacy order service — kept for phone-based patient flows.
// Canonical schema: pharmacy_orders (patient_id int, priority, prescribed_by, dispensed_by,
// confirmation_notes, items_list jsonb, etc.). See also controllers/pharmacy/pharmacyOrderController.js
// for the richer delivery-tracking flow.

import { setTenantTx } from '../../lib/prisma.js';
import { requireTenantId } from '../tenant/tenantService.js';

// Prisma-select for the base pharmacy_orders columns returned by every
// list view. Swapped out for SELECT-string clumping so renames fail at
// query-construction.
const ORDER_LIST_SELECT = {
  id: true,
  uid: true,
  phone: true,
  patient_id: true,
  patient_name: true,
  order_note: true,
  file_key: true,
  priority: true,
  status: true,
  confirmation_notes: true,
  prescribed_by: true,
  dispensed_by: true,
  ordered_at: true,
  updated_at: true,
  // The dispensed medication schedule per line item. The patient app
  // and pharmacy queue both need this to safely administer multi-drug
  // regimens at home (e.g. post-cataract eye drops). Finding
  // 2026-05-10-surgical-day-care-patient-pharmacy-order-omits-eye-drop-schedule.
  items_list: true,
};

export const getOrdersByUID = async (uid, filters) => {
  const tenantId = requireTenantId(filters.tenantId);
  return setTenantTx(tenantId, async (tx) => {
    const user = await tx.users.findFirst({
      where: {
        tenant_id: tenantId,
        uid,
        role: 'PATIENT',
        is_active: true,
        status: 'active',
        is_deleted: false,
        merged_into_uid: null,
      },
      select: { id: true },
    });
    if (!user) return { orders: [], filters };
    const safeLimit = Math.max(1, parseInt(filters.limit) || 50);
    const safeOffset = Math.max(0, parseInt(filters.offset) || 0);
    const where = {
      tenant_id: tenantId,
      patient_id: user.id,
    };
    if (filters.status) where.status = filters.status;
    const rows = await tx.pharmacy_orders.findMany({
      where,
      select: ORDER_LIST_SELECT,
      orderBy: { ordered_at: 'desc' },
      take: safeLimit,
      skip: safeOffset,
    });
    return {
      orders: rows,
      filters: { status: filters.status, limit: safeLimit, offset: safeOffset },
    };
  });
};
