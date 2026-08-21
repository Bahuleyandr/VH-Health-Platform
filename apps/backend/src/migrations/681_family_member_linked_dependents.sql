-- 681 — Family-member → linked-dependent promotion substrate.
--
-- `family_members` (migration 100) is a guardian's address book of
-- non-account contacts; `users.guardian_user_id` (migration 202) is the
-- platform's canonical guardian→minor link that the X-Acting-As-Uid
-- delegation hop live-validates. Promotion bridges the two: a contact row
-- gains a real minor patient identity (a `users` row with
-- guardian_user_id set — minted with a synthetic DEPEND- phone exactly
-- like the walk-in minor path, or matched to an existing minor account by
-- phone), and the contact records which identity it was promoted into
-- plus the guardian's consent declaration made at promotion time.
--
-- No parallel authorization mechanism is introduced: authority to act for
-- the dependent remains `users.guardian_user_id` (acting-as hop, D72
-- explicit-URL reads, booking-on-behalf); revocation remains the existing
-- unlink flow (which also revokes the delegated guardian↔dependent token
-- tuple). These columns are the promotion/consent evidence only.

ALTER TABLE public.family_members
  ADD COLUMN IF NOT EXISTS linked_dependent_uid uuid NULL,
  ADD COLUMN IF NOT EXISTS linked_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS link_consent_method varchar(30) NULL,
  ADD COLUMN IF NOT EXISTS link_consent_ref varchar(200) NULL;

-- If the dependent identity is ever hard-deleted, the contact reverts to a
-- plain address-book row rather than dangling.
ALTER TABLE public.family_members
  DROP CONSTRAINT IF EXISTS fk_family_members_linked_dependent;
ALTER TABLE public.family_members
  ADD CONSTRAINT fk_family_members_linked_dependent
    FOREIGN KEY (linked_dependent_uid) REFERENCES public.users (uid)
    ON UPDATE NO ACTION ON DELETE SET NULL;

-- Linkage columns travel together: a linked contact must carry the link
-- timestamp and the consent method captured at promotion; an unlinked
-- contact carries none of them. (ON DELETE SET NULL only clears the uid,
-- so the pair check is scoped to linked_at/link_consent_method — a row
-- whose identity was deleted keeps its historical consent evidence only
-- in the audit log, and the trigger-free way to keep the constraint
-- satisfiable is to require the evidence columns exactly when the uid is
-- present.)
ALTER TABLE public.family_members
  DROP CONSTRAINT IF EXISTS chk_family_members_link_evidence;
ALTER TABLE public.family_members
  ADD CONSTRAINT chk_family_members_link_evidence CHECK (
    linked_dependent_uid IS NULL
    OR (linked_at IS NOT NULL AND link_consent_method IS NOT NULL)
  );

ALTER TABLE public.family_members
  DROP CONSTRAINT IF EXISTS chk_family_members_link_consent_method;
ALTER TABLE public.family_members
  ADD CONSTRAINT chk_family_members_link_consent_method CHECK (
    link_consent_method IS NULL
    OR link_consent_method IN
      ('guardian_declaration', 'written', 'verbal_documented', 'otp')
  );

-- One contact row per promoted dependent identity per guardian. The
-- trailing (TRUE) expression column is deliberate (migration-580 idiom,
-- ux_workflow_steps_one_current / migration-640
-- ux_admissions_one_active_per_patient): a constant adds nothing to the
-- key, but it makes this an expression index that `prisma db pull` skips,
-- so introspection cannot mis-infer the single-column users FKs these
-- columns participate in as one-to-one relations.
CREATE UNIQUE INDEX IF NOT EXISTS ux_family_members_linked_dependent
  ON public.family_members (patient_uid, linked_dependent_uid, (TRUE))
  WHERE linked_dependent_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_family_members_linked_dependent_uid
  ON public.family_members (linked_dependent_uid)
  WHERE linked_dependent_uid IS NOT NULL;
