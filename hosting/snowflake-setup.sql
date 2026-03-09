-- ═══════════════════════════════════════════════════════════════════════════
-- SNOWFLAKE SETUP SCRIPT
-- Run as ACCOUNTADMIN in a Snowflake SQL worksheet
-- Creates the warehouse, database, schema, role, and service user
-- needed for the MarTech tracking stack.
-- ═══════════════════════════════════════════════════════════════════════════

USE ROLE ACCOUNTADMIN;


-- ─── 1. Warehouse ─────────────────────────────────────────────────────────────
-- X-Small is sufficient for dbt runs and audience pipeline queries
CREATE WAREHOUSE IF NOT EXISTS TRANSFORMING_WH
  WAREHOUSE_SIZE = 'X-SMALL'
  AUTO_SUSPEND   = 60       -- suspend after 60 seconds of inactivity
  AUTO_RESUME    = TRUE
  INITIALLY_SUSPENDED = TRUE
  COMMENT = 'Warehouse for dbt transforms and audience sync pipeline';


-- ─── 2. Database & Schema ─────────────────────────────────────────────────────
CREATE DATABASE IF NOT EXISTS PROD
  COMMENT = 'Production data warehouse';

CREATE SCHEMA IF NOT EXISTS PROD.RAW
  COMMENT = 'Raw/source data loaded by Fivetran or custom loaders';

CREATE SCHEMA IF NOT EXISTS PROD.STAGING
  COMMENT = 'dbt staging models — cleaned source data';

CREATE SCHEMA IF NOT EXISTS PROD.ANALYTICS
  COMMENT = 'dbt mart models — BI-ready tables for reporting and audience sync';


-- ─── 3. Role ──────────────────────────────────────────────────────────────────
CREATE ROLE IF NOT EXISTS MARTECH_PIPELINE_ROLE
  COMMENT = 'Role for MarTech pipeline service accounts';

-- Warehouse access
GRANT USAGE ON WAREHOUSE TRANSFORMING_WH TO ROLE MARTECH_PIPELINE_ROLE;

-- Database access
GRANT USAGE ON DATABASE PROD TO ROLE MARTECH_PIPELINE_ROLE;

-- Schema access — read from RAW, read/write to STAGING and ANALYTICS
GRANT USAGE ON SCHEMA PROD.RAW      TO ROLE MARTECH_PIPELINE_ROLE;
GRANT USAGE ON SCHEMA PROD.STAGING  TO ROLE MARTECH_PIPELINE_ROLE;
GRANT USAGE ON SCHEMA PROD.ANALYTICS TO ROLE MARTECH_PIPELINE_ROLE;

GRANT SELECT ON ALL TABLES IN SCHEMA PROD.RAW      TO ROLE MARTECH_PIPELINE_ROLE;
GRANT SELECT ON ALL TABLES IN SCHEMA PROD.STAGING  TO ROLE MARTECH_PIPELINE_ROLE;
GRANT SELECT ON ALL TABLES IN SCHEMA PROD.ANALYTICS TO ROLE MARTECH_PIPELINE_ROLE;

-- Future grants (important — covers tables created by dbt runs)
GRANT SELECT ON FUTURE TABLES IN SCHEMA PROD.RAW       TO ROLE MARTECH_PIPELINE_ROLE;
GRANT SELECT ON FUTURE TABLES IN SCHEMA PROD.STAGING   TO ROLE MARTECH_PIPELINE_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON FUTURE TABLES IN SCHEMA PROD.ANALYTICS TO ROLE MARTECH_PIPELINE_ROLE;

-- dbt needs to create/replace/drop tables and views in STAGING and ANALYTICS
GRANT CREATE TABLE  ON SCHEMA PROD.STAGING   TO ROLE MARTECH_PIPELINE_ROLE;
GRANT CREATE TABLE  ON SCHEMA PROD.ANALYTICS TO ROLE MARTECH_PIPELINE_ROLE;
GRANT CREATE VIEW   ON SCHEMA PROD.STAGING   TO ROLE MARTECH_PIPELINE_ROLE;
GRANT CREATE VIEW   ON SCHEMA PROD.ANALYTICS TO ROLE MARTECH_PIPELINE_ROLE;


-- ─── 4. Service User ──────────────────────────────────────────────────────────
-- Replace <YOUR-STRONG-PASSWORD> with a generated password (20+ chars)
-- Use a password manager — store as SNOWFLAKE_PASSWORD in .env

CREATE USER IF NOT EXISTS svc_martech
  PASSWORD           = '<YOUR-STRONG-PASSWORD>'
  LOGIN_NAME         = 'svc_martech'
  DISPLAY_NAME       = 'MarTech Pipeline Service Account'
  DEFAULT_ROLE       = MARTECH_PIPELINE_ROLE
  DEFAULT_WAREHOUSE  = TRANSFORMING_WH
  DEFAULT_NAMESPACE  = PROD.ANALYTICS
  MUST_CHANGE_PASSWORD = FALSE
  COMMENT = 'Service account for dbt and audience sync pipeline';

GRANT ROLE MARTECH_PIPELINE_ROLE TO USER svc_martech;


-- ─── 5. Verify ────────────────────────────────────────────────────────────────
-- Run these to confirm setup is correct

SHOW WAREHOUSES LIKE 'TRANSFORMING_WH';
SHOW SCHEMAS IN DATABASE PROD;
SHOW GRANTS TO ROLE MARTECH_PIPELINE_ROLE;
SHOW GRANTS TO USER svc_martech;


-- ─── 6. Test Connection ───────────────────────────────────────────────────────
-- Run as svc_martech to confirm permissions work:
-- USE ROLE MARTECH_PIPELINE_ROLE;
-- USE WAREHOUSE TRANSFORMING_WH;
-- USE SCHEMA PROD.ANALYTICS;
-- SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE();
-- Expected: svc_martech | MARTECH_PIPELINE_ROLE | TRANSFORMING_WH
