-- ═══════════════════════════════════════════════════════════════════════════
-- dbt Models — Marketing Analytics Source-of-Truth Reporting Layer
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Model hierarchy:
--   sources (raw) → staging (cleaned) → intermediate → marts (BI-ready)
--
-- Source systems:
--   - Snowflake raw: GA4 (BigQuery export), HubSpot CRM, Google Ads, Meta Ads
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── STAGING: stg_ga4_events ─────────────────────────────────────────────────
-- models/staging/stg_ga4_events.sql

{{
  config(
    materialized = 'incremental',
    unique_key   = 'event_key',
    on_schema_change = 'append_new_columns'
  )
}}

WITH raw AS (
  SELECT
    event_date,
    event_timestamp,
    event_name,
    event_params,
    user_id,
    user_pseudo_id AS client_id,
    device,
    geo,
    traffic_source,
    collected_traffic_source
  FROM {{ source('ga4', 'events') }}
  WHERE _TABLE_SUFFIX >= '{{ var("start_date", "20240101") }}'
  {% if is_incremental() %}
    AND PARSE_DATE('%Y%m%d', _TABLE_SUFFIX) > (SELECT MAX(event_date) FROM {{ this }})
  {% endif %}
)

SELECT
  -- Keys
  GENERATE_UUID()                                             AS event_key,
  TIMESTAMP_MICROS(event_timestamp)                           AS event_timestamp,
  PARSE_DATE('%Y%m%d', event_date)                            AS event_date,
  event_name,
  client_id,
  user_id,

  -- Event params (unnested)
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'session_id')     AS session_id,
  (SELECT value.int_value     FROM UNNEST(event_params) WHERE key = 'engagement_time_msec') AS engagement_ms,
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'page_location')  AS page_url,
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'source')         AS utm_source,
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'medium')         AS utm_medium,
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'campaign')       AS utm_campaign,
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'transaction_id') AS transaction_id,
  (SELECT value.double_value  FROM UNNEST(event_params) WHERE key = 'value')          AS event_value,
  (SELECT value.string_value  FROM UNNEST(event_params) WHERE key = 'currency')       AS currency,

  -- Attribution
  COALESCE(
    collected_traffic_source.manual_source,
    traffic_source.source,
    '(direct)'
  )                                                           AS attributed_source,

  COALESCE(
    collected_traffic_source.manual_medium,
    traffic_source.medium,
    '(none)'
  )                                                           AS attributed_medium,

  -- Device
  device.category                                             AS device_category,
  device.operating_system                                     AS os,
  device.browser                                              AS browser,
  geo.country                                                 AS country,
  geo.region                                                  AS region

FROM raw


-- ─── STAGING: stg_crm_contacts ───────────────────────────────────────────────
-- models/staging/stg_crm_contacts.sql

/*
{{
  config(materialized = 'incremental', unique_key = 'contact_id')
}}

SELECT
  hs_object_id::VARCHAR                   AS contact_id,
  email,
  phone,
  firstname                               AS first_name,
  lastname                                AS last_name,
  company,
  jobtitle                                AS job_title,
  hs_lifecyclestage_lead_date::DATE       AS lead_date,
  hs_lifecyclestage_marketingqualifiedlead_date::DATE AS mql_date,
  hs_lifecyclestage_salesqualifiedlead_date::DATE     AS sql_date,
  hs_lifecyclestage_opportunity_date::DATE AS opp_date,
  hs_lifecyclestage_customer_date::DATE   AS customer_date,
  lifecyclestage                          AS current_stage,
  hs_lead_status                          AS lead_status,
  hubspot_owner_id                        AS owner_id,
  createdate::TIMESTAMP                   AS created_at,
  lastmodifieddate::TIMESTAMP             AS updated_at,
  -- UTM attribution stored on contact (first touch)
  hs_analytics_source                     AS first_touch_source,
  hs_analytics_source_data_1              AS first_touch_medium,
  hs_analytics_source_data_2              AS first_touch_campaign,
  -- Last touch
  recent_conversion_event_name            AS last_conversion_event,
  recent_conversion_date::DATE            AS last_conversion_date,
  hs_email_optout                         AS is_unsubscribed
FROM {{ source('hubspot', 'contacts') }}
{% if is_incremental() %}
WHERE lastmodifieddate > (SELECT MAX(updated_at) FROM {{ this }})
{% endif %}
*/


-- ─── MART: mart_channel_performance ─────────────────────────────────────────
-- models/marts/mart_channel_performance.sql
-- Source of truth for paid media reporting — resolves GA4 vs CRM vs Ad Platform

/*
{{
  config(
    materialized = 'table',
    tags         = ['daily', 'marketing', 'source-of-truth']
  )
}}

WITH

-- Pull spend from ad platforms (Google + Meta + LinkedIn)
ad_spend AS (
  SELECT
    date,
    channel,
    campaign_name,
    campaign_id,
    SUM(cost_usd)         AS spend,
    SUM(impressions)      AS impressions,
    SUM(clicks)           AS clicks,
    SUM(platform_leads)   AS platform_reported_leads,
    SUM(platform_conversions) AS platform_reported_conversions
  FROM {{ ref('int_ad_spend_unified') }}
  GROUP BY 1, 2, 3, 4
),

-- Pull GA4 sessions/events attributed to paid
ga4_sessions AS (
  SELECT
    event_date                          AS date,
    attributed_source                   AS channel,
    utm_campaign                        AS campaign_name,
    COUNT(DISTINCT session_id)          AS sessions,
    COUNT(DISTINCT CASE WHEN event_name = 'lead_form_submit' THEN session_id END) AS ga4_leads,
    COUNT(DISTINCT CASE WHEN event_name = 'trial_started'    THEN session_id END) AS ga4_trials,
    COUNT(DISTINCT CASE WHEN event_name = 'purchase'         THEN transaction_id END) AS ga4_purchases,
    SUM(CASE WHEN event_name = 'purchase' THEN event_value ELSE 0 END) AS ga4_revenue
  FROM {{ ref('stg_ga4_events') }}
  WHERE attributed_medium IN ('cpc', 'paid-social', 'paid_social', 'display')
  GROUP BY 1, 2, 3
),

-- CRM MQLs attributed to paid (first-touch)
crm_mqls AS (
  SELECT
    mql_date                            AS date,
    first_touch_source                  AS channel,
    first_touch_campaign                AS campaign_name,
    COUNT(DISTINCT contact_id)          AS crm_mqls,
    COUNT(DISTINCT CASE WHEN customer_date IS NOT NULL THEN contact_id END) AS crm_customers
  FROM {{ ref('stg_crm_contacts') }}
  WHERE mql_date IS NOT NULL
    AND first_touch_medium IN ('cpc', 'paid-social', 'paid_social')
  GROUP BY 1, 2, 3
)

SELECT
  COALESCE(s.date, g.date, c.date)          AS date,
  COALESCE(s.channel, g.channel, c.channel) AS channel,
  COALESCE(s.campaign_name, g.campaign_name, c.campaign_name) AS campaign_name,

  -- Spend (from ad platforms — source of truth for cost)
  COALESCE(s.spend, 0)                       AS spend,
  COALESCE(s.impressions, 0)                 AS impressions,
  COALESCE(s.clicks, 0)                      AS clicks,

  -- Traffic (from GA4 — source of truth for sessions)
  COALESCE(g.sessions, 0)                    AS sessions,
  SAFE_DIVIDE(COALESCE(g.sessions,0), NULLIF(s.clicks,0)) AS click_to_session_rate,

  -- Leads (triangulated: GA4 first, CRM for MQLs)
  COALESCE(g.ga4_leads, 0)                   AS ga4_leads,
  COALESCE(c.crm_mqls, 0)                    AS crm_mqls,
  COALESCE(s.platform_reported_leads, 0)     AS platform_reported_leads,

  -- Downstream outcomes (CRM source of truth)
  COALESCE(c.crm_customers, 0)               AS crm_customers,
  COALESCE(g.ga4_revenue, 0)                 AS ga4_revenue,

  -- Efficiency metrics
  SAFE_DIVIDE(s.spend, NULLIF(g.ga4_leads, 0))    AS cpl_ga4,
  SAFE_DIVIDE(s.spend, NULLIF(c.crm_mqls, 0))     AS cpl_crm_mql,
  SAFE_DIVIDE(s.spend, NULLIF(c.crm_customers, 0)) AS cac,
  SAFE_DIVIDE(g.ga4_revenue, NULLIF(s.spend, 0))  AS roas,

  -- Discrepancy flag for QC
  CASE
    WHEN ABS(g.ga4_leads - s.platform_reported_leads) / NULLIF(GREATEST(g.ga4_leads, s.platform_reported_leads),0) > 0.30
    THEN TRUE ELSE FALSE
  END AS tracking_discrepancy_flag

FROM ad_spend s
FULL OUTER JOIN ga4_sessions g  ON s.date = g.date AND s.channel = g.channel AND s.campaign_name = g.campaign_name
FULL OUTER JOIN crm_mqls     c  ON s.date = c.date AND s.channel = c.channel AND s.campaign_name = c.campaign_name
*/
