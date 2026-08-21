-- 687_dietary_ticket_allergy_screen_and_recall.sql
--
-- Adversarial-review fix group 2 (dietary clinical safety) on migration 685.
--
-- Two blockers on dietary_meal_tickets:
--
-- 1. Allergen screening was inert: menu selection matched allergen tags only
--    against diet_orders.allergies, a column no first-party client writes
--    (staff diet-order dialog and admin New Order form both omit it). Ticket
--    generation now screens against the UNION of the platform's canonical
--    allergy answer (getUnifiedActiveAllergies — all four allergy stores)
--    plus the diet order's free-text allergies/restrictions, and persists the
--    screen evidence per the radiology contrast idiom
--    (radiology_orders.contrast_allergy_screen, migration 678):
--
--      allergy_screen JSONB — what the screen knew when the ticket was cut:
--        { screened_at, degraded, sources_failed, patient_allergies,
--          order_allergies, order_restrictions, excluded: [{id, name, tag,
--          matched, via}] }
--      A degraded screen (any unified source failed) fails CLOSED: every
--      menu item carrying allergen tags is excluded and the evidence says so.
--
-- 2. Nothing recalled a tray past 'pending': an NPO change or discharge left
--    preparing/ready/dispatched/delivered trays live. Kitchen-side tickets
--    (pending/preparing/ready — the tray has not left the kitchen) are now
--    cancelled with a reason, which fits the existing status vocabulary. A
--    tray already OUT of the kitchen (dispatched/delivered) cannot be
--    silently cancelled — someone is holding it on a ward — so it gets a
--    flagged "do not serve" recall marker instead:
--
--      recalled_at / recalled_by / recall_reason — the recall order (set by
--        diet-order re-sync on NPO/diet change, or the discharge hooks).
--        transitionTicket refuses ->dispatched/->delivered (409) while set.
--      recall_ack_at / recall_ack_by — the ward leg's acknowledgement,
--        stamped when the recalled tray is cancelled (dispatched) or
--        collected back (delivered). The recall stays visible on the ticket
--        row either way; a recall is never overwritten once set.
--
-- Status vocabulary is deliberately unchanged: 'cancelled' remains the only
-- non-live terminal, so the live-uniqueness index (685) keeps exactly one
-- in-flight tray per (diet_order, service_date, meal_type) until the ward
-- acknowledges the recall — a replacement cannot be cut while a do-not-serve
-- tray is still unaccounted for.

BEGIN;

ALTER TABLE dietary_meal_tickets
  ADD COLUMN IF NOT EXISTS allergy_screen JSONB,
  ADD COLUMN IF NOT EXISTS recalled_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recalled_by    UUID,
  ADD COLUMN IF NOT EXISTS recall_reason  VARCHAR(255),
  ADD COLUMN IF NOT EXISTS recall_ack_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS recall_ack_by  UUID;

-- Recall evidence is all-or-nothing: a recall always names its actor and
-- reason (same shape rule as the 685 cancel-evidence CHECK).
ALTER TABLE dietary_meal_tickets
  ADD CONSTRAINT chk_dietary_meal_ticket_recall_evidence
    CHECK ((recalled_at IS NULL AND recalled_by IS NULL AND recall_reason IS NULL)
           OR (recalled_at IS NOT NULL AND recalled_by IS NOT NULL
               AND recall_reason IS NOT NULL));

-- An acknowledgement requires a recall to acknowledge, and always names the
-- acknowledging actor.
ALTER TABLE dietary_meal_tickets
  ADD CONSTRAINT chk_dietary_meal_ticket_recall_ack
    CHECK ((recall_ack_at IS NULL AND recall_ack_by IS NULL)
           OR (recall_ack_at IS NOT NULL AND recall_ack_by IS NOT NULL
               AND recalled_at IS NOT NULL));

COMMENT ON COLUMN dietary_meal_tickets.allergy_screen IS
  'Generation-time allergen screen evidence (radiology contrast_allergy_screen idiom): unified-allergy union + order free-text screened against menu allergen tags; degraded screens fail closed (allergen-tagged items excluded) and say so here.';
COMMENT ON COLUMN dietary_meal_tickets.recalled_at IS
  'Do-not-serve recall marker for trays already out of the kitchen (dispatched/delivered) when the diet order changed/NPO''d or the admission ended. Forward transitions refuse while set; the ward acknowledges via recall_ack_* when cancelling or collecting the tray.';

COMMIT;
