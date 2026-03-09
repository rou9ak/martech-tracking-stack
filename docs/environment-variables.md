# Environment Variables Reference

Copy `.env.example` to `.env` and fill in your values. Never commit `.env` to version control.

---

## Google Ads

| Variable | Where to find it | Used in |
|---|---|---|
| `GADS_CUSTOMER_ID` | Google Ads → top right account selector (format: 123-456-7890) | Offline conversions |
| `GADS_CONVERSION_ID` | Ads → Goals → Conversions → click action → Tag setup | GTM server tag |
| `GADS_CONVERSION_LABEL` | Same location as above | GTM server tag |

To use the Google Ads API for offline conversion uploads, you also need:
- A **Google Ads API developer token** (applied for via Google)
- **OAuth2 credentials** (client ID + secret + refresh token)

For managed accounts, use a **Manager Account (MCC)** token.

---

## Meta

| Variable | Where to find it | Used in |
|---|---|---|
| `META_PIXEL_ID` | Events Manager → your pixel → Settings | GTM server tag |
| `META_CAPI_TOKEN` | Events Manager → your pixel → Settings → Conversions API → Generate access token | GTM server tag |
| `META_DATASET_ID` | Events Manager → Offline event set → your dataset ID | Offline conversions |
| `META_OFFLINE_TOKEN` | Business Settings → System Users → generate token with `ads_management` permission | Offline conversions |
| `META_TEST_CODE` | Events Manager → Test Events → server events → test code | Development only — remove in production |

**Important:** `META_CAPI_TOKEN` and `META_OFFLINE_TOKEN` may be different tokens depending on your Business Manager setup. CAPI (server-side, real-time) uses a pixel-level token. Offline conversions use a dataset-level token.

---

## LinkedIn

| Variable | Where to find it | Used in |
|---|---|---|
| `LI_PARTNER_ID` | Campaign Manager → Account Assets → Insight Tag | GTM server tag |
| `LI_ACCOUNT_ID` | Campaign Manager → top account selector | Audience sync |
| `LI_ACCESS_TOKEN` | LinkedIn Developer Portal → your app → Auth → OAuth 2.0 tokens | All LinkedIn calls |
| `LI_CONV_LEAD` | Campaign Manager → Analyze → Conversion tracking → your conversion ID | Offline conversions |
| `LI_CONV_MQL` | Same location | Offline conversions |
| `LI_CONV_CUSTOMER` | Same location | Offline conversions |

LinkedIn access tokens expire. Implement refresh token rotation or use a long-lived token from a LinkedIn System Application.

---

## HubSpot

| Variable | Where to find it | Used in |
|---|---|---|
| `HUBSPOT_CLIENT_SECRET` | HubSpot → Settings → Integrations → Private Apps → your app → Auth | Webhook signature verification |
| `HUBSPOT_ACCESS_TOKEN` | Same location → Access token tab | CRM enrichment API calls |

---

## GA4

| Variable | Where to find it | Used in |
|---|---|---|
| `GA4_MEASUREMENT_ID` | GA4 Admin → Data Streams → your stream → Measurement ID (G-XXXXXXXX) | GTM server tag |
| `GA4_API_SECRET` | Same location → Measurement Protocol API secrets → Create | GTM server tag |

**Security note:** `GA4_API_SECRET` is for server-side Measurement Protocol only. Do not expose it in browser-side GTM tags or JavaScript.

---

## Snowflake

| Variable | Description |
|---|---|
| `SNOWFLAKE_ACCOUNT` | Your account identifier (e.g., `xy12345.us-east-1`) |
| `SNOWFLAKE_DATABASE` | Database where dbt models are materialised |
| `SNOWFLAKE_SCHEMA` | Schema (e.g., `ANALYTICS`) |
| `SNOWFLAKE_WAREHOUSE` | Compute warehouse for query execution |
| `SNOWFLAKE_USERNAME` | Service account username |
| `SNOWFLAKE_PASSWORD` | Service account password (prefer key-pair auth in production) |

---

## Example .env

```bash
# Google Ads
GADS_CUSTOMER_ID=123-456-7890
GADS_CONVERSION_ID=AW-XXXXXXXXX
GADS_CONVERSION_LABEL=AbCdEfGhIj

# Meta
META_PIXEL_ID=1234567890123456
META_CAPI_TOKEN=EAAxxxxxxxxx
META_DATASET_ID=9876543210987654
META_OFFLINE_TOKEN=EAAyyyyyyyyy
META_TEST_CODE=TEST12345

# LinkedIn
LI_PARTNER_ID=1234567
LI_ACCOUNT_ID=503123456
LI_ACCESS_TOKEN=AQV...
LI_CONV_LEAD=1234567
LI_CONV_MQL=2345678
LI_CONV_CUSTOMER=3456789

# HubSpot
HUBSPOT_CLIENT_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
HUBSPOT_ACCESS_TOKEN=pat-eu1-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# GA4
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=abc123def456

# Snowflake
SNOWFLAKE_ACCOUNT=xy12345.us-east-1
SNOWFLAKE_DATABASE=PROD
SNOWFLAKE_SCHEMA=ANALYTICS
SNOWFLAKE_WAREHOUSE=TRANSFORMING_WH
SNOWFLAKE_USERNAME=svc_dbt
SNOWFLAKE_PASSWORD=
```
