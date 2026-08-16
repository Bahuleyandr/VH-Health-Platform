-- 685_dietary_kitchen_meal_tickets.sql
--
-- Feature wave 8 — kitchen management on top of diet orders.
--
-- Gap: dietary today is diet-order CRUD plus a flat worklist
-- (services/dietary/dietaryService.js). The kitchen has no menu master, no
-- per-meal production tickets, and no tray tracking — staff cook from a list
-- of standing orders with no record of which meal went to which bed, when it
-- left the kitchen, or whether the tray came back.
--
-- Two tables:
--
--   dietary_menu_items  — tenant menu master. Each item belongs to one meal
--                         window (breakfast/lunch/dinner/snack) and declares
--                         which diet_orders.diet_type values it suits
--                         (diet_types[]), a veg/non-veg flag, and free-text
--                         allergen tags matched (case-insensitively) against
--                         diet_orders.allergies at ticket generation.
--                         'npo' is deliberately absent from the diet_types
--                         vocabulary: nil-by-mouth patients get no menu and
--                         no tickets.
--
--   dietary_meal_tickets — one kitchen production ticket per
--                         (diet order, service date, meal). Generated each
--                         morning by the scheduler for every ACTIVE diet
--                         order whose patient holds a live admission
--                         (admissions.status = 'admitted' AND discharged_at
--                         IS NULL), and re-synced on same-day diet-order
--                         changes. Carries generation-time snapshots
--                         (patient, ward/bed, diet spec, restrictions,
--                         allergies, matched menu selections) so the kitchen
--                         cooks from the ticket, not from a join.
--
-- Ticket lifecycle (service-enforced transition map; the DB pins the enum,
-- the live-uniqueness, and the terminal-state evidence):
--
--   pending -> preparing -> ready -> dispatched -> delivered -> collected
--   pending/preparing/ready/dispatched -> cancelled
--
--   pending..dispatched are kitchen-side (dietary capability roles);
--   dispatched -> delivered -> collected is the ward-side tray-tracking leg
--   (ward/clinical staff on the dietary mount). Each transition stamps
--   <status>_at + <status>_by.
--
-- Uniqueness: at most ONE live (non-cancelled) ticket per
-- (diet_order_id, service_date, meal_type) — partial unique with the house
-- trailing-(TRUE) idiom. Cancelled tickets stay as history and a regenerate
-- may mint a replacement.
--
-- Canonical timeline: the 'delivered' transition (meal actually served to an
-- admitted patient — the patient-facing clinical fact, relevant to intake and
-- NPO safety) emits one clinical_timeline_events + clinical_audit_events pair
-- in the same transaction, fixed key dietary_meal_tickets:<id>:delivered
-- (insert-once: delivered is reachable exactly once per ticket). Bulk ticket
-- generation deliberately does not write per-ticket timeline rows — four
-- rows/patient/day of "ticket created" is the aggregate-noise class the
-- canonical-timeline doc excludes; the audit story for generation is the
-- ticket row itself (generated_source/generated_by).
--
-- No workflow_sla_instances: meal service has no seeded SLA rule class and
-- this wave does not invent one.
--
-- RLS follows the referral_facilities (680) / counter-sales (684)
-- request-path pattern: permissive tenant_isolation; the service always
-- writes tenant_id explicitly from request context.

BEGIN;

CREATE TABLE IF NOT EXISTS dietary_menu_items (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  meal_type      VARCHAR(20) NOT NULL
    CONSTRAINT chk_dietary_menu_item_meal_type
      CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  -- Which diet_orders.diet_type values this dish suits. Vocabulary is the
  -- diet-order enum minus 'npo' (nothing by mouth -> nothing on a menu).
  diet_types     TEXT[] NOT NULL DEFAULT '{}'
    CONSTRAINT chk_dietary_menu_item_diet_types
      CHECK (diet_types <@ ARRAY['regular', 'diabetic', 'cardiac', 'renal',
                                 'soft', 'liquid', 'enteral']::text[]),
  is_veg         BOOLEAN NOT NULL DEFAULT TRUE,
  -- Free-text allergen tags (e.g. 'peanut', 'milk', 'gluten'); ticket
  -- generation excludes an item when any tag intersects the order's
  -- allergies case-insensitively.
  allergen_tags  TEXT[] NOT NULL DEFAULT '{}',
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live item per (tenant, meal window, name); deactivated items free the
-- name for a replacement. Trailing (TRUE) per the house partial-unique idiom.
CREATE UNIQUE INDEX IF NOT EXISTS ux_dietary_menu_items_live_name
  ON dietary_menu_items (tenant_id, meal_type, lower(name), (TRUE))
  WHERE active;
CREATE INDEX IF NOT EXISTS idx_dietary_menu_items_tenant_meal
  ON dietary_menu_items (tenant_id, meal_type) WHERE active;

CREATE TABLE IF NOT EXISTS dietary_meal_tickets (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  diet_order_id   INTEGER NOT NULL REFERENCES diet_orders(id) ON DELETE CASCADE,
  patient_uid     UUID NOT NULL REFERENCES users(uid),
  service_date    DATE NOT NULL,
  meal_type       VARCHAR(20) NOT NULL
    CONSTRAINT chk_dietary_meal_ticket_meal_type
      CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),

  -- Generation-time snapshots: the kitchen cooks and the tray is routed from
  -- what was true when the ticket was cut, even if the order or bed moves
  -- later (a same-day order change cancels pending tickets and re-cuts).
  admission_id    INTEGER REFERENCES admissions(id),
  ward            VARCHAR(255),
  bed_number      VARCHAR(50),
  patient_name    VARCHAR(255),
  diet_type       VARCHAR(50) NOT NULL,
  restrictions    TEXT[] NOT NULL DEFAULT '{}',
  allergies       TEXT[] NOT NULL DEFAULT '{}',
  calories_target NUMERIC(8, 2),
  -- Menu items matched at generation: [{id, name, is_veg}, ...]. Empty when
  -- nothing on the menu suits — diet_spec then tells the kitchen what to
  -- prepare.
  menu_selections JSONB NOT NULL DEFAULT '[]'::jsonb,
  diet_spec       TEXT,
  special_instructions TEXT,

  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
    CONSTRAINT chk_dietary_meal_ticket_status
      CHECK (status IN ('pending', 'preparing', 'ready', 'dispatched',
                        'delivered', 'collected', 'cancelled')),

  generated_source VARCHAR(20) NOT NULL DEFAULT 'scheduler'
    CONSTRAINT chk_dietary_meal_ticket_source
      CHECK (generated_source IN ('scheduler', 'manual', 'order_change')),
  generated_by    UUID,

  -- Actor + timestamp per transition (tray tracking is the later trio).
  preparing_at    TIMESTAMPTZ,
  preparing_by    UUID,
  ready_at        TIMESTAMPTZ,
  ready_by        UUID,
  dispatched_at   TIMESTAMPTZ,
  dispatched_by   UUID,
  delivered_at    TIMESTAMPTZ,
  delivered_by    UUID,
  collected_at    TIMESTAMPTZ,
  collected_by    UUID,
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    UUID,
  cancel_reason   VARCHAR(255),

  -- Terminal/served evidence is all-or-nothing with the status.
  CONSTRAINT chk_dietary_meal_ticket_cancel_evidence
    CHECK ((status = 'cancelled')
           = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
              AND cancel_reason IS NOT NULL)),
  CONSTRAINT chk_dietary_meal_ticket_delivered_evidence
    CHECK (status NOT IN ('delivered', 'collected') OR delivered_at IS NOT NULL),
  CONSTRAINT chk_dietary_meal_ticket_collected_evidence
    CHECK (status <> 'collected' OR collected_at IS NOT NULL),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live ticket per (diet order, service date, meal). Trailing (TRUE) per
-- the house partial-unique idiom over FK-subset columns.
CREATE UNIQUE INDEX IF NOT EXISTS ux_dietary_meal_tickets_live
  ON dietary_meal_tickets (diet_order_id, service_date, meal_type, (TRUE))
  WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_dietary_meal_tickets_board
  ON dietary_meal_tickets (tenant_id, service_date, meal_type, status);
CREATE INDEX IF NOT EXISTS idx_dietary_meal_tickets_patient
  ON dietary_meal_tickets (patient_uid);
CREATE INDEX IF NOT EXISTS idx_dietary_meal_tickets_order
  ON dietary_meal_tickets (diet_order_id);

-- RLS: permissive tenant_isolation (request-path pattern; service writes
-- tenant_id explicitly).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dietary_menu_items',
    'dietary_meal_tickets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
        WITH CHECK (
          current_setting('app.current_tenant_id', true) IS NULL
          OR current_setting('app.current_tenant_id', true) = ''
          OR current_setting('app.current_tenant_id', true) = 'bypass'
          OR tenant_id = app_current_tenant_id_uuid()
        )
    $p$, t);
  END LOOP;
END $$;

COMMENT ON TABLE dietary_menu_items IS
  'Tenant kitchen menu master. Each item belongs to one meal window and declares the diet_orders.diet_type values it suits (npo excluded by vocabulary), veg flag, and allergen tags matched against diet_orders.allergies at ticket generation.';
COMMENT ON TABLE dietary_meal_tickets IS
  'Per-meal kitchen production tickets: one live row per (diet_order, service_date, meal_type), generated for ACTIVE diet orders of currently admitted patients with generation-time patient/bed/diet snapshots. pending->preparing->ready->dispatched is the kitchen leg; dispatched->delivered->collected is ward-side tray tracking; cancellation requires actor + reason.';
COMMENT ON COLUMN dietary_meal_tickets.menu_selections IS
  'Menu items matched at generation ([{id, name, is_veg}]) — meal_type match + diet_type suitability + no case-insensitive allergen intersection. Empty when nothing suits; diet_spec then carries the free-text preparation spec.';

COMMIT;
