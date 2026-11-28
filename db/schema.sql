
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Institutes table
CREATE TABLE IF NOT EXISTS institutes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE
);

-- People table
CREATE TABLE IF NOT EXISTS people (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institute_id UUID NOT NULL REFERENCES institutes(id),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Prevent duplicate person names within the same institute
    CONSTRAINT unique_person_per_institute
    UNIQUE (institute_id, name)
);

-- Enable row-level security
ALTER TABLE people ENABLE ROW LEVEL SECURITY;

-- Force RLS even for the table owner
ALTER TABLE people FORCE ROW LEVEL SECURITY;

-- Remove existing policy if present
DROP POLICY IF EXISTS inst_isolation ON people;

-- Institute-level access policy
CREATE POLICY inst_isolation
ON people
USING (
    institute_id =
    NULLIF(current_setting('app.institute_id', true), '')::UUID
)
WITH CHECK (
    institute_id =
    NULLIF(current_setting('app.institute_id', true), '')::UUID
);

-- Create restricted application user if it does not exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM pg_roles WHERE rolname = 'app_user'
    ) THEN
        CREATE ROLE app_user LOGIN
        PASSWORD 'change_me'
        NOSUPERUSER
        NOCREATEDB
        NOCREATEROLE
        NOINHERIT
        NOBYPASSRLS;
    END IF;
END
$$;

-- Grant database permissions
GRANT CONNECT ON DATABASE postgres TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- Grant people table permissions
GRANT SELECT, INSERT, UPDATE, DELETE
ON people TO app_user;

-- Grant institute table read permission
GRANT SELECT ON institutes TO app_user;

-- ---------------------------------------------------------------------------
-- Razorpay test-payment experiment
-- ---------------------------------------------------------------------------

-- One row per real payment. The unique razorpay_payment_id is the last line of
-- defence: even if two webhook deliveries race, only one row can exist.
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institute_id UUID NOT NULL REFERENCES institutes(id),
    razorpay_payment_id VARCHAR(64) NOT NULL UNIQUE,
    razorpay_payment_link_id VARCHAR(64),
    amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
    currency CHAR(3) NOT NULL DEFAULT 'INR',
    status VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inst_isolation ON payments;
CREATE POLICY inst_isolation
ON payments
USING (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
)
WITH CHECK (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
);

-- Webhook deliveries already handled (Razorpay sends a unique id per event in
-- the X-Razorpay-Event-Id header). Not institute-scoped: it holds no tenant data.
CREATE TABLE IF NOT EXISTS webhook_events (
    event_id VARCHAR(100) PRIMARY KEY,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Payments can be read and added, never changed or deleted by the app user.
GRANT SELECT, INSERT ON payments TO app_user;
GRANT SELECT, INSERT ON webhook_events TO app_user;

-- ---------------------------------------------------------------------------
-- CRM tables: Students, Courses, Enquiries
-- ---------------------------------------------------------------------------

-- Students table
CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institute_id UUID NOT NULL REFERENCES institutes(id),
    name VARCHAR(100) NOT NULL,
    city VARCHAR(100),
    course VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'Pending',
    joined DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE students FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inst_isolation ON students;
CREATE POLICY inst_isolation
ON students
USING (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
)
WITH CHECK (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
);

GRANT SELECT, INSERT, UPDATE, DELETE ON students TO app_user;

-- Courses table
CREATE TABLE IF NOT EXISTS courses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institute_id UUID NOT NULL REFERENCES institutes(id),
    name VARCHAR(100) NOT NULL,
    icon VARCHAR(10) NOT NULL DEFAULT '📚',
    description TEXT,
    fees VARCHAR(50),
    seats_filled INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE courses FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inst_isolation ON courses;
CREATE POLICY inst_isolation
ON courses
USING (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
)
WITH CHECK (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
);

GRANT SELECT, INSERT, UPDATE, DELETE ON courses TO app_user;

-- Enquiries table
CREATE TABLE IF NOT EXISTS enquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    institute_id UUID NOT NULL REFERENCES institutes(id),
    name VARCHAR(100) NOT NULL,
    course VARCHAR(100) NOT NULL,
    stage INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE enquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE enquiries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inst_isolation ON enquiries;
CREATE POLICY inst_isolation
ON enquiries
USING (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
)
WITH CHECK (
    institute_id = NULLIF(current_setting('app.institute_id', true), '')::UUID
);

GRANT SELECT, INSERT, UPDATE, DELETE ON enquiries TO app_user;

-- ---------------------------------------------------------------------------
-- Attendance machine experiment, step 1: raw punches
-- ---------------------------------------------------------------------------

-- Everything the machine sends is saved here exactly as received, before any
-- parsing. The body is BYTEA so not even the character encoding is touched.
-- Not institute-scoped (no RLS): at intake we do not yet know which institute
-- a device belongs to. Append-only: the app user can add and read, never
-- change or delete.
CREATE TABLE IF NOT EXISTS raw_punches (
    id BIGSERIAL PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    device_serial VARCHAR(100),
    method VARCHAR(10) NOT NULL,
    url TEXT NOT NULL,
    source_ip VARCHAR(64),
    headers JSONB NOT NULL,
    body BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS raw_punches_device_received_idx
    ON raw_punches (device_serial, received_at);

GRANT SELECT, INSERT ON raw_punches TO app_user;
GRANT USAGE, SELECT ON SEQUENCE raw_punches_id_seq TO app_user;

-- ---------------------------------------------------------------------------
-- Attendance machine experiment, step 2: clean punches
-- ---------------------------------------------------------------------------

-- One row per real punch, parsed out of raw_punches. The UNIQUE constraint is
-- the dedupe: the same employee at the same device time on the same machine can
-- only exist once, however many times the machine sends it (retries, backlog
-- re-sends after an outage). Not institute-scoped yet: the device-to-institute
-- link comes later. Append-only for the app user.
CREATE TABLE IF NOT EXISTS punches (
    id BIGSERIAL PRIMARY KEY,
    raw_punch_id BIGINT NOT NULL REFERENCES raw_punches(id),
    device_serial VARCHAR(100) NOT NULL,
    employee_pin VARCHAR(50) NOT NULL,
    device_time TIMESTAMP NOT NULL,            -- wall-clock time exactly as the machine printed it
    status SMALLINT,
    verify_mode SMALLINT,
    received_at TIMESTAMPTZ NOT NULL,          -- when OUR server got it
    batch_size INTEGER NOT NULL,               -- punches in the upload (1 = live push)
    device_time_utc TIMESTAMPTZ NOT NULL,      -- device_time read in the machine's timezone
    lag_seconds BIGINT NOT NULL,               -- received_at minus device_time_utc
    clock_offset_seconds BIGINT NOT NULL DEFAULT 0, -- correction applied (0 = none)
    corrected_time TIMESTAMPTZ NOT NULL,       -- device_time_utc + clock_offset_seconds
    clock_flag VARCHAR(20) NOT NULL,           -- ok | late | future | corrected
    CONSTRAINT punches_once UNIQUE (device_serial, employee_pin, device_time)
);

CREATE INDEX IF NOT EXISTS punches_device_single_idx
    ON punches (device_serial, received_at) WHERE batch_size = 1;

-- Bookkeeping: which raw uploads have been turned into punches. Anything not
-- listed here (or listed with an error) is picked up by the reprocess command.
CREATE TABLE IF NOT EXISTS processed_raw_punches (
    raw_punch_id BIGINT PRIMARY KEY REFERENCES raw_punches(id),
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind VARCHAR(20) NOT NULL,                 -- attlog | skipped
    lines INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    bad_lines INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

GRANT SELECT, INSERT ON punches TO app_user;
GRANT USAGE, SELECT ON SEQUENCE punches_id_seq TO app_user;
GRANT SELECT, INSERT, UPDATE ON processed_raw_punches TO app_user;