-- 083_pharmacy_fk_constraints.sql
--
-- Declares the pharmacy_orders relations so Prisma introspection produces
-- include-capable relations — same pattern as batch 082 for investigations.
-- The four getAllOrders list queries in orderService.js LEFT JOIN users on
-- `po.phone = u.phone` today; with a real FK on patient_id (proper integer
-- FK) we can migrate them to `include: { users: ... }` and let Prisma
-- catch column-name drift across both tables at query-construction.
--
-- Pre-flight on dev (pharmacy_orders, 2026-04-24):
--   * 0 rows with NULL patient_id (legacy phone-only orders would have had
--     NULL; all current orders resolve phone→id at create time)
--   * 0 orphan patient_id / prescribed_by / dispensed_by rows
--   * 0 orphan pharmacy_order_history.changed_by rows
-- → all four FKs validate cleanly.

-- patient_id → users.id. Nullable column; ON DELETE SET NULL preserves the
-- order record if a patient is purged.
ALTER TABLE pharmacy_orders
  DROP CONSTRAINT IF EXISTS pharmacy_orders_patient_id_fkey,
  ADD CONSTRAINT pharmacy_orders_patient_id_fkey
    FOREIGN KEY (patient_id) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- prescribed_by → users.uid (the uuid of the doctor who prescribed).
-- Nullable — legacy / pharmacist-walk-in orders have this null.
ALTER TABLE pharmacy_orders
  DROP CONSTRAINT IF EXISTS pharmacy_orders_prescribed_by_fkey,
  ADD CONSTRAINT pharmacy_orders_prescribed_by_fkey
    FOREIGN KEY (prescribed_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- dispensed_by → users.uid (the uuid of the pharmacist who dispensed).
-- Nullable — only populated once an order progresses past DISPENSED.
ALTER TABLE pharmacy_orders
  DROP CONSTRAINT IF EXISTS pharmacy_orders_dispensed_by_fkey,
  ADD CONSTRAINT pharmacy_orders_dispensed_by_fkey
    FOREIGN KEY (dispensed_by) REFERENCES users(uid)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;

-- pharmacy_order_history.changed_by → users.id. Integer FK (the history
-- table used the legacy int user-id column long before uuid migration).
ALTER TABLE pharmacy_order_history
  DROP CONSTRAINT IF EXISTS pharmacy_order_history_changed_by_fkey,
  ADD CONSTRAINT pharmacy_order_history_changed_by_fkey
    FOREIGN KEY (changed_by) REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE NO ACTION;
