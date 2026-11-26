
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
