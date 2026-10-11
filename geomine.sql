-- =====================================================================
-- GeoMine AI: Phase 1 schema (PostgreSQL 15+ with PostGIS)
-- Legacy-data digitization, AI extraction with human review,
-- provenance on every record, private vs shared datasets.
-- Written for Supabase (uses auth.uid()).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE org_role        AS ENUM ('owner', 'admin', 'geologist', 'viewer');
CREATE TYPE visibility      AS ENUM ('private', 'organization', 'shared');
CREATE TYPE doc_type        AS ENUM ('map', 'report', 'borehole_log', 'assay_sheet',
                                     'field_notebook', 'table', 'other');
CREATE TYPE ingest_status   AS ENUM ('uploaded', 'processing', 'extracted', 'failed');
CREATE TYPE review_status   AS ENUM ('pending', 'accepted', 'corrected', 'rejected');
CREATE TYPE record_origin   AS ENUM ('ai_extracted', 'manual_entry', 'imported_structured');

-- ---------------------------------------------------------------------
-- Organizations and users
-- ---------------------------------------------------------------------
CREATE TABLE organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    kind        text,                    -- 'junior_explorer', 'university', 'government'...
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per person; id matches Supabase auth.users.id
CREATE TABLE profiles (
    id          uuid PRIMARY KEY,
    full_name   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
    org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES profiles(id)      ON DELETE CASCADE,
    role     org_role NOT NULL DEFAULT 'viewer',
    PRIMARY KEY (org_id, user_id)
);

-- ---------------------------------------------------------------------
-- Datasets: the unit of ownership, licensing and sharing
-- ---------------------------------------------------------------------
CREATE TABLE datasets (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_org_id           uuid NOT NULL REFERENCES organizations(id),
    name                   text NOT NULL,
    description            text,
    visibility             visibility NOT NULL DEFAULT 'private',
    source_name            text,         -- 'GSD Digital Store', 'Company archive'...
    licence_terms          text,
    licence_ref            text,         -- receipt / purchase / permission reference
    redistribution_allowed boolean NOT NULL DEFAULT false,
    created_by             uuid REFERENCES profiles(id),
    created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX datasets_owner_idx ON datasets(owner_org_id);

-- ---------------------------------------------------------------------
-- Provenance: source documents and extraction runs
-- ---------------------------------------------------------------------
CREATE TABLE source_documents (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id      uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    title           text NOT NULL,
    doc_type        doc_type NOT NULL DEFAULT 'other',
    storage_path    text NOT NULL,       -- object-storage key of the original file
    sha256          text NOT NULL,       -- duplicate detection, proof file unchanged
    page_count      integer,
    original_author text,
    original_year   integer,
    original_ref    text,                -- archive / report number printed on the document
    status          ingest_status NOT NULL DEFAULT 'uploaded',
    uploaded_by     uuid REFERENCES profiles(id),
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, sha256)
);
CREATE INDEX source_documents_dataset_idx ON source_documents(dataset_id);

CREATE TABLE extraction_runs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     uuid NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
    model_name      text NOT NULL,
    model_version   text,
    prompt_version  text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    status          ingest_status NOT NULL DEFAULT 'processing',
    notes           text
);
CREATE INDEX extraction_runs_doc_idx ON extraction_runs(document_id);

-- ---------------------------------------------------------------------
-- Core records (all carry the same provenance columns).
-- Coordinates: WGS84 (4326) for queries; original values and CRS are kept
-- because legacy Zambian maps often use older datums (e.g. Arc 1950 / UTM).
-- ---------------------------------------------------------------------
CREATE TABLE mineral_occurrences (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id          uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    name                text,
    commodities         text[] NOT NULL DEFAULT '{}',
    deposit_type        text,
    occurrence_status   text,            -- 'prospect', 'past producer'...
    description         text,
    location            geometry(Point, 4326),
    original_x          double precision,
    original_y          double precision,
    original_crs_epsg   integer,
    location_accuracy_m double precision,
    origin              record_origin NOT NULL DEFAULT 'ai_extracted',
    document_id         uuid REFERENCES source_documents(id) ON DELETE SET NULL,
    source_page         integer,
    extraction_run_id   uuid REFERENCES extraction_runs(id) ON DELETE SET NULL,
    extracted_at        timestamptz,
    record_review       review_status NOT NULL DEFAULT 'pending',
    created_by          uuid REFERENCES profiles(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX occurrences_geom_idx    ON mineral_occurrences USING gist (location);
CREATE INDEX occurrences_dataset_idx ON mineral_occurrences(dataset_id);
CREATE INDEX occurrences_commod_idx  ON mineral_occurrences USING gin (commodities);
CREATE INDEX occurrences_name_trgm   ON mineral_occurrences USING gin (name gin_trgm_ops);

CREATE TABLE boreholes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id          uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    hole_id             text NOT NULL,   -- identifier as written in the source
    collar              geometry(PointZ, 4326),
    original_x          double precision,
    original_y          double precision,
    original_crs_epsg   integer,
    collar_elevation_m  double precision,
    total_depth_m       double precision,
    azimuth_deg         double precision,
    dip_deg             double precision,
    drilled_year        integer,
    contractor          text,
    origin              record_origin NOT NULL DEFAULT 'ai_extracted',
    document_id         uuid REFERENCES source_documents(id) ON DELETE SET NULL,
    source_page         integer,
    extraction_run_id   uuid REFERENCES extraction_runs(id) ON DELETE SET NULL,
    extracted_at        timestamptz,
    record_review       review_status NOT NULL DEFAULT 'pending',
    created_by          uuid REFERENCES profiles(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, hole_id)
);
CREATE INDEX boreholes_geom_idx    ON boreholes USING gist (collar);
CREATE INDEX boreholes_dataset_idx ON boreholes(dataset_id);

CREATE TABLE geochemical_samples (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_id          uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
    sample_id           text NOT NULL,
    sample_type         text,            -- soil, stream sediment, rock chip, core...
    location            geometry(Point, 4326),
    original_x          double precision,
    original_y          double precision,
    original_crs_epsg   integer,
    borehole_id         uuid REFERENCES boreholes(id) ON DELETE SET NULL,
    depth_from_m        double precision,
    depth_to_m          double precision,
    collected_on        date,
    lab                 text,
    method              text,
    -- {"Cu": {"value": 0.42, "unit": "%", "below_detection": false}, ...}
    assays              jsonb NOT NULL DEFAULT '{}',
    origin              record_origin NOT NULL DEFAULT 'ai_extracted',
    document_id         uuid REFERENCES source_documents(id) ON DELETE SET NULL,
    source_page         integer,
    extraction_run_id   uuid REFERENCES extraction_runs(id) ON DELETE SET NULL,
    extracted_at        timestamptz,
    record_review       review_status NOT NULL DEFAULT 'pending',
    created_by          uuid REFERENCES profiles(id),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, sample_id)
);
CREATE INDEX samples_geom_idx    ON geochemical_samples USING gist (location);
CREATE INDEX samples_assays_idx  ON geochemical_samples USING gin (assays);
CREATE INDEX samples_dataset_idx ON geochemical_samples(dataset_id);

-- ---------------------------------------------------------------------
-- Field-level extraction and review: confidence, position on the page,
-- and the human decision for every AI-extracted value.
-- ---------------------------------------------------------------------
CREATE TABLE extracted_fields (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
    record_table     text NOT NULL CHECK (record_table IN
                       ('mineral_occurrences', 'boreholes', 'geochemical_samples')),
    record_id        uuid NOT NULL,
    field_name       text NOT NULL,
    extracted_value  text,
    confidence       numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
    page_number      integer,
    bbox             jsonb,              -- {"x":0.12,"y":0.40,"w":0.20,"h":0.03} as page fractions
    review           review_status NOT NULL DEFAULT 'pending',
    corrected_value  text,
    reviewed_by      uuid REFERENCES profiles(id),
    reviewed_at      timestamptz
);
CREATE INDEX extracted_fields_record_idx  ON extracted_fields(record_table, record_id);
CREATE INDEX extracted_fields_run_idx     ON extracted_fields(run_id);
CREATE INDEX extracted_fields_pending_idx ON extracted_fields(run_id) WHERE review = 'pending';
CREATE INDEX extracted_fields_lowconf_idx ON extracted_fields(confidence) WHERE review = 'pending';

-- ---------------------------------------------------------------------
-- Audit trail: who changed what, with before/after values
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor_id    uuid,
    table_name  text NOT NULL,
    row_id      uuid,
    action      text NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
    old_data    jsonb,
    new_data    jsonb
);
CREATE INDEX audit_log_row_idx ON audit_log(table_name, row_id);

-- ---------------------------------------------------------------------
-- Triggers: keep updated_at fresh, and fill the audit log
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TRIGGER occurrences_touch BEFORE UPDATE ON mineral_occurrences
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER boreholes_touch BEFORE UPDATE ON boreholes
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER samples_touch BEFORE UPDATE ON geochemical_samples
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION audit_row() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE rid uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN rid := OLD.id; ELSE rid := NEW.id; END IF;
    INSERT INTO audit_log (actor_id, table_name, row_id, action, old_data, new_data)
    VALUES (auth.uid(), TG_TABLE_NAME, rid, lower(TG_OP),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
    RETURN NULL;
END $$;

CREATE TRIGGER occurrences_audit AFTER INSERT OR UPDATE OR DELETE ON mineral_occurrences
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER boreholes_audit AFTER INSERT OR UPDATE OR DELETE ON boreholes
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER samples_audit AFTER INSERT OR UPDATE OR DELETE ON geochemical_samples
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER fields_audit AFTER INSERT OR UPDATE OR DELETE ON extracted_fields
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER datasets_audit AFTER INSERT OR UPDATE OR DELETE ON datasets
    FOR EACH ROW EXECUTE FUNCTION audit_row();

-- ---------------------------------------------------------------------
-- Access helpers
--   private / organization : only the owning org's members
--   shared                 : any signed-in user can read; only the owner org writes
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_org_member(p_org uuid, p_min_write boolean DEFAULT false)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.org_id = p_org AND m.user_id = auth.uid()
          AND (NOT p_min_write OR m.role IN ('owner', 'admin', 'geologist'))
    );
$$;

CREATE OR REPLACE FUNCTION is_org_admin(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.org_id = p_org AND m.user_id = auth.uid()
          AND m.role IN ('owner', 'admin')
    );
$$;

CREATE OR REPLACE FUNCTION can_read_dataset(p_dataset uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM datasets d
        WHERE d.id = p_dataset
          AND (d.visibility = 'shared' OR is_org_member(d.owner_org_id))
    );
$$;

CREATE OR REPLACE FUNCTION can_write_dataset(p_dataset uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM datasets d
        WHERE d.id = p_dataset AND is_org_member(d.owner_org_id, true)
    );
$$;

-- Creates an organization and makes the caller its owner (also creates their profile)
CREATE OR REPLACE FUNCTION create_organization(p_name text, p_kind text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_org uuid;
BEGIN
    IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
    INSERT INTO profiles (id) VALUES (auth.uid()) ON CONFLICT (id) DO NOTHING;
    INSERT INTO organizations (name, kind) VALUES (p_name, p_kind) RETURNING id INTO new_org;
    INSERT INTO memberships (org_id, user_id, role) VALUES (new_org, auth.uid(), 'owner');
    RETURN new_org;
END $$;

-- ---------------------------------------------------------------------
-- Row-level security: ON for every table
-- ---------------------------------------------------------------------
ALTER TABLE organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships          ENABLE ROW LEVEL SECURITY;
ALTER TABLE datasets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE source_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE extraction_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mineral_occurrences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE boreholes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE geochemical_samples  ENABLE ROW LEVEL SECURITY;
ALTER TABLE extracted_fields     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log            ENABLE ROW LEVEL SECURITY;  -- no policy: server-side only

-- Organizations, profiles, memberships
CREATE POLICY org_read   ON organizations FOR SELECT USING (is_org_member(id));
CREATE POLICY org_update ON organizations FOR UPDATE USING (is_org_admin(id)) WITH CHECK (is_org_admin(id));
CREATE POLICY org_delete ON organizations FOR DELETE USING (is_org_admin(id));

CREATE POLICY profile_self ON profiles FOR ALL
    USING (id = auth.uid()) WITH CHECK (id = auth.uid());

CREATE POLICY member_read  ON memberships FOR SELECT
    USING (user_id = auth.uid() OR is_org_member(org_id));
CREATE POLICY member_write ON memberships FOR ALL
    USING (is_org_admin(org_id)) WITH CHECK (is_org_admin(org_id));

-- Datasets
CREATE POLICY datasets_read  ON datasets FOR SELECT
    USING (visibility = 'shared' OR is_org_member(owner_org_id));
CREATE POLICY datasets_write ON datasets FOR ALL
    USING (is_org_member(owner_org_id, true)) WITH CHECK (is_org_member(owner_org_id, true));

-- Source documents: other orgs can see originals of a shared dataset
-- only when the licence permits redistribution.
CREATE POLICY docs_read ON source_documents FOR SELECT USING (
    is_org_member((SELECT owner_org_id FROM datasets WHERE id = dataset_id))
    OR EXISTS (SELECT 1 FROM datasets d WHERE d.id = dataset_id
               AND d.visibility = 'shared' AND d.redistribution_allowed)
);
CREATE POLICY docs_write ON source_documents FOR ALL
    USING (can_write_dataset(dataset_id)) WITH CHECK (can_write_dataset(dataset_id));

-- Extraction runs and extracted fields follow their document's dataset
CREATE POLICY runs_read ON extraction_runs FOR SELECT USING (
    can_read_dataset((SELECT dataset_id FROM source_documents WHERE id = document_id)));
CREATE POLICY runs_write ON extraction_runs FOR ALL
    USING (can_write_dataset((SELECT dataset_id FROM source_documents WHERE id = document_id)))
    WITH CHECK (can_write_dataset((SELECT dataset_id FROM source_documents WHERE id = document_id)));

CREATE POLICY fields_read ON extracted_fields FOR SELECT USING (
    can_read_dataset((SELECT s.dataset_id FROM extraction_runs r
                      JOIN source_documents s ON s.id = r.document_id WHERE r.id = run_id)));
CREATE POLICY fields_write ON extracted_fields FOR ALL
    USING (can_write_dataset((SELECT s.dataset_id FROM extraction_runs r
                              JOIN source_documents s ON s.id = r.document_id WHERE r.id = run_id)))
    WITH CHECK (can_write_dataset((SELECT s.dataset_id FROM extraction_runs r
                              JOIN source_documents s ON s.id = r.document_id WHERE r.id = run_id)));

-- Records
CREATE POLICY occ_read  ON mineral_occurrences FOR SELECT USING (can_read_dataset(dataset_id));
CREATE POLICY occ_write ON mineral_occurrences FOR ALL
    USING (can_write_dataset(dataset_id)) WITH CHECK (can_write_dataset(dataset_id));

CREATE POLICY bh_read  ON boreholes FOR SELECT USING (can_read_dataset(dataset_id));
CREATE POLICY bh_write ON boreholes FOR ALL
    USING (can_write_dataset(dataset_id)) WITH CHECK (can_write_dataset(dataset_id));

CREATE POLICY smp_read  ON geochemical_samples FOR SELECT USING (can_read_dataset(dataset_id));
CREATE POLICY smp_write ON geochemical_samples FOR ALL
    USING (can_write_dataset(dataset_id)) WITH CHECK (can_write_dataset(dataset_id));

-- ---------------------------------------------------------------------
-- Views (security_invoker so the caller's access rules still apply)
-- ---------------------------------------------------------------------
-- Only records a person has checked: use for analysis and export.
CREATE VIEW verified_occurrences WITH (security_invoker = true) AS
    SELECT * FROM mineral_occurrences
    WHERE record_review IN ('accepted', 'corrected');

-- Review queue: lowest-confidence pending fields first.
CREATE VIEW review_queue WITH (security_invoker = true) AS
    SELECT f.id, f.run_id, r.document_id, f.record_table, f.record_id,
           f.field_name, f.extracted_value, f.confidence, f.page_number, f.bbox
    FROM extracted_fields f
    JOIN extraction_runs r ON r.id = f.run_id
    WHERE f.review = 'pending'
    ORDER BY f.confidence ASC NULLS FIRST;

-- Citation string for any occurrence, built from its provenance.
CREATE VIEW occurrence_citations WITH (security_invoker = true) AS
    SELECT o.id AS occurrence_id,
           d.title, d.original_author, d.original_year, d.original_ref,
           o.source_page, o.extracted_at,
           concat_ws(', ', d.original_author, d.original_year::text, d.title,
                     'p. ' || o.source_page, d.original_ref) AS citation
    FROM mineral_occurrences o
    LEFT JOIN source_documents d ON d.id = o.document_id;