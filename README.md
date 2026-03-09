# Full-Funnel Marketing Attribution Stack

> End-to-end marketing tracking infrastructure: server-side GTM → Conversion APIs → CRM sync → BI reporting.  
> Built to solve the real problem: **ad platforms lie about conversions, and most tracking stacks let them.**

---

## The Problem This Solves

| Signal Loss Source | Typical Impact |
|---|---|
| Ad blockers + ITP (Safari) | 25–40% of browser events never fire |
| GA4 ↔ Google Ads attribution mismatch | 20–35% variance without alignment |
| No offline conversions | Platforms optimise for leads, not revenue |
| Stale audience lists | Suppressions miss 30%+ of active users |
| No source-of-truth reporting | Every team has a different "right" number |

This stack addresses all five.

---

## Architecture

```
Browser (client)
  │
  └──▶ GTM Web Container
            │  transport_url → Stape proxy
            ▼
       GTM Server Container (Stape-hosted)
            │
            ├──▶ GA4 Measurement Protocol   (API Secret, server-side only)
            ├──▶ Meta Conversions API        (access_token + fbp/fbc forwarding)
            ├──▶ Google Ads Conversion API   (GCLID match or SHA-256 email)
            └──▶ LinkedIn Conversions API    (SHA-256 email)

CRM (HubSpot)
  │  lifecycle stage change webhook
  └──▶ Offline Conversion Pipeline
            │
            ├──▶ Google Ads uploadClickConversion
            ├──▶ Meta Offline Conversions API
            └──▶ LinkedIn Conversions API

Snowflake (dbt-transformed)
  └──▶ Audience Sync Pipeline
            ├──▶ Google Ads Customer Match
            ├──▶ Meta Custom Audiences
            └──▶ LinkedIn Matched Audiences
```

---

## Modules

### 1. [`src/gtm-server/`](./src/gtm-server/) — Server-Side GTM Stack

Replaces unreliable browser pixels with a server-side event routing layer hosted on [Stape](https://stape.io).

**Key design decisions:**
- All ad platform credentials (API secrets, access tokens) live server-side only — never exposed to the browser
- Canonical event schema enforced at ingestion — malformed events are rejected before reaching any platform
- SHA-256 PII hashing happens server-side — raw email/phone never touches ad platform APIs
- Meta CAPI deduplication via stable `event_id` generated once client-side, forwarded through the server container

**Destinations handled:** GA4 · Meta CAPI · Google Ads · LinkedIn CAPI

→ [View code](./src/gtm-server/server-side-gtm-config.js) · [Architecture detail](./docs/gtm-server-architecture.md)

---

### 2. [`src/conversion-api/`](./src/conversion-api/) — Offline Conversion Pipeline

Closes the attribution loop from first ad click to closed-won revenue by syncing HubSpot CRM lifecycle stage changes back to all ad platforms.

**How it works:**
1. HubSpot fires a webhook on every `lifecyclestage` property change
2. Webhook signature is verified (HMAC-SHA256)
3. Contact record is enriched from CRM (email, phone, GCLID, deal value)
4. Stage is mapped to platform-specific conversion actions
5. Fan-out to Google Ads, Meta, and LinkedIn in parallel (`Promise.allSettled`)

**Lifecycle stage → conversion mapping:**

| CRM Stage | Google Ads | Meta | LinkedIn |
|---|---|---|---|
| Lead | `CONV_LEAD` | `Lead` | `LI_CONV_LEAD` |
| MQL | `CONV_MQL` | `QualifiedLead` | `LI_CONV_MQL` |
| SQL | `CONV_SQL` | `SQLead` | — |
| Closed Won | `CONV_CLOSED_WON` | `Purchase` | `LI_CONV_CUSTOMER` |

**Identity resolution priority:** GCLID → SHA-256 email → SHA-256 phone

→ [View code](./src/conversion-api/offline-conversions.js) · [Setup guide](./docs/offline-conversions-setup.md)

---

### 3. [`src/audience-pipeline/`](./src/audience-pipeline/) — Audience Sync (Hightouch-style)

Reads from Snowflake (dbt-transformed CRM + behavioural data) and pushes hashed, identity-resolved audience segments to all major ad platforms on automated schedules.

**Audiences:**

| Segment | Definition | Refresh | Use |
|---|---|---|---|
| High Intent Leads | Pricing page + form submit, 30d | Every 4hr | Retargeting |
| Closed-Won Seed | All customers, last 12mo | Daily | Lookalike |
| Active Trial Users | Current trial accounts | Every 2hr | **Suppression** |
| Winback Targets | Churned ≥$5k ARR, 7–180d | Daily | Winback |

**Data quality gates (every sync run):**
- Empty list guard — aborts if record count = 0 (prevents clearing live ad platform list)
- Size deviation alert — flags >40% variance from expected size
- Email coverage check — minimum 60% required
- Duplicate detection — flags >5% duplicate rate
- PII scan — asserts no plaintext email/phone in upload payload

→ [View code](./src/audience-pipeline/audience-sync.js)

---

### 4. [`src/tracking-debugger/`](./src/tracking-debugger/) — Discrepancy Audit Tool

Systematically compares event counts across all systems, categorises severity, and generates prioritised root-cause hypotheses.

**Checks run:**
- GA4 vs Google Ads conversion counts
- Meta browser pixel vs CAPI (deduplication health)
- CRM lead count vs ad platform attribution
- GTM server vs GA4 browser event counts

**Severity thresholds:**

| Variance | Severity | Action |
|---|---|---|
| < 5% | ✅ OK | Normal — de-dup / timezone drift |
| 5–15% | ℹ️ Info | Monitor |
| 15–30% | ⚠️ Warning | Investigate |
| > 30% | 🚨 Critical | Immediate action |

Also includes `traceEventEnd2End(eventId)` — traces a single event across browser pixel → GTM server → GA4 → Meta CAPI → CRM to pinpoint exactly where signal is lost.

→ [View code](./src/tracking-debugger/discrepancy-audit.js) · [Debugging playbook](./docs/debugging-playbook.md)

---

### 5. [`src/bi-reporting/`](./src/bi-reporting/) — dbt Models (Source-of-Truth Layer)

dbt SQL models for Snowflake / BigQuery that resolve the fundamental reporting problem: every system reports different numbers for the same campaign.

**Source-of-truth ownership:**

| Metric | Source of Truth | Why |
|---|---|---|
| Cost / Spend | Ad platform API | Only the platform knows actual billing |
| Sessions / Traffic | GA4 | Most complete cross-device view |
| MQLs / SQLs | CRM (HubSpot) | Qualification happens in CRM |
| Revenue / ARR | CRM / billing | GA4 only sees initial transaction |
| CAC / ROAS | Calculated (spend ÷ CRM outcomes) | Cross-system derived |

**Models included:**
- `stg_ga4_events` — incremental GA4 event staging with UTM normalisation
- `stg_crm_contacts` — HubSpot contacts with full lifecycle stage history
- `mart_channel_performance` — unified channel view with discrepancy flag

→ [View models](./src/bi-reporting/dbt_models.sql)

---

## Results (Real-World Benchmarks)

| Metric | Before | After |
|---|---|---|
| Event capture rate (ad-blocked users) | Baseline | +34% |
| GA4 ↔ Google Ads variance | 28% | 6% |
| Meta CAPI match rate | 62% (pixel only) | 87% |
| Google Ads tCPA | Baseline | −19% (value-based bidding) |
| Attribution visibility | Click → lead | Click → MQL → SQL → revenue |
| Offline conversion delay | Daily batch | <2 minutes (webhook) |

---

## Stack

| Layer | Tools |
|---|---|
| Tag Management | GTM Web, GTM Server-Side, Stape |
| Conversion APIs | Meta CAPI, Google Ads API, LinkedIn CAPI |
| CRM | HubSpot (webhooks + CRM API v3) |
| Audience Sync | Hightouch / custom pipeline |
| Data Warehouse | Snowflake, BigQuery |
| Transformation | dbt |
| BI | Looker, Metabase |
| Runtime | Node.js (AWS Lambda / Cloud Run) |

---

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/martech-tracking-stack
cd martech-tracking-stack
npm install
cp .env.example .env
# Add your credentials to .env (see docs/environment-variables.md)
```

See [`docs/`](./docs/) for per-module setup guides.

---

## Environment Variables

```bash
# Google Ads
GADS_CUSTOMER_ID=
GADS_CONVERSION_ID=

# Meta
META_PIXEL_ID=
META_CAPI_TOKEN=
META_DATASET_ID=

# LinkedIn
LI_PARTNER_ID=
LI_ACCESS_TOKEN=

# HubSpot
HUBSPOT_CLIENT_SECRET=

# Snowflake
SNOWFLAKE_ACCOUNT=
SNOWFLAKE_DATABASE=
SNOWFLAKE_SCHEMA=
SNOWFLAKE_WAREHOUSE=
```

Full reference: [`docs/environment-variables.md`](./docs/environment-variables.md)

---

## Repo Structure

```
martech-tracking-stack/
├── src/
│   ├── gtm-server/            # Server-side GTM event routing
│   │   └── server-side-gtm-config.js
│   ├── conversion-api/        # CRM → ad platform offline conversions
│   │   └── offline-conversions.js
│   ├── audience-pipeline/     # Snowflake → ad platform audience sync
│   │   └── audience-sync.js
│   ├── tracking-debugger/     # Cross-system discrepancy audit
│   │   └── discrepancy-audit.js
│   └── bi-reporting/          # dbt staging + mart models
│       └── dbt_models.sql
├── docs/
│   ├── gtm-server-architecture.md
│   ├── offline-conversions-setup.md
│   ├── debugging-playbook.md
│   └── environment-variables.md
├── .env.example
├── package.json
└── README.md
```

---

## License

MIT
