# Setup Checklist — Do These In Order

Work through each platform top-to-bottom. Each step produces a credential
that goes into your `.env` file.

---

## Phase 1 — Hosting & Tag Management (Day 1, ~30 min)

- [ ] **Stape** — Create account at stape.io → start with Pro plan ($20/mo)
- [ ] **Stape** — Create a new "Server GTM Hosting" container → choose your region
- [ ] **GTM** — Create Server container at tagmanager.google.com → copy Container Config
- [ ] **Stape** — Paste Container Config into Stape container setup
- [ ] **Stape** — Add custom domain (e.g. `collect.yourdomain.com`) → add CNAME in DNS
- [ ] **GTM Web** — Add Google Tag → set `transport_url` to your Stape domain → publish
- [ ] **Stape** — Verify domain shows green checkmark (may take up to 24hr for DNS)

**Credentials collected:** `STAPE_CONTAINER_URL`, `GTM_WEB_CONTAINER_ID`, `GTM_SERVER_CONTAINER_ID`

---

## Phase 2 — Analytics & Google Ads (Day 1, ~20 min)

- [ ] **GA4** — Copy Measurement ID from Admin → Data Streams
- [ ] **GA4** — Create API Secret (Measurement Protocol) → store immediately, shown once
- [ ] **Google Ads** — Note Customer ID (top right, remove hyphens)
- [ ] **Google Ads** — Create 4 conversion actions (Lead, MQL, SQL, Closed Won)
- [ ] **Google Ads** — Copy Conversion ID + Label for each action
- [ ] **Google Ads** — Enable Enhanced Conversions for Leads

**Credentials collected:** `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `GADS_CUSTOMER_ID`, `GADS_CONVERSION_ID`, `GADS_LABEL_*`

---

## Phase 3 — Meta (Day 1, ~20 min)

- [ ] **Meta** — Note Pixel ID from Events Manager
- [ ] **Meta** — Generate CAPI access token (Events Manager → pixel → Settings)
- [ ] **Meta** — Create Offline event dataset → note Dataset ID
- [ ] **Meta** — Create System User in Business Settings → generate token with `ads_management`
- [ ] **Meta** — Note Test Event code for development

**Credentials collected:** `META_PIXEL_ID`, `META_CAPI_TOKEN`, `META_DATASET_ID`, `META_OFFLINE_TOKEN`, `META_TEST_CODE`

---

## Phase 4 — LinkedIn (Day 2, ~20 min)

- [ ] **LinkedIn** — Note Partner ID (Campaign Manager → Insight Tag)
- [ ] **LinkedIn** — Note Account ID (from URL)
- [ ] **LinkedIn** — Create LinkedIn Developer App → request `rw_conversions` scope
- [ ] **LinkedIn** — Generate OAuth access token
- [ ] **LinkedIn** — Create 3 conversion actions (Lead, MQL, Customer) using "API" method
- [ ] **LinkedIn** — Note each Conversion ID

**Credentials collected:** `LI_PARTNER_ID`, `LI_ACCOUNT_ID`, `LI_ACCESS_TOKEN`, `LI_CONV_*`

---

## Phase 5 — HubSpot (Day 2, ~20 min)

- [ ] **HubSpot** — Create Private App with `crm.objects.contacts.read` + `crm.objects.deals.read`
- [ ] **HubSpot** — Copy Access Token (pat-...)
- [ ] **HubSpot** — Copy Client Secret (for webhook verification)
- [ ] **HubSpot** — Create webhook subscription on `lifecyclestage` property change
- [ ] **HubSpot** — Create custom contact properties: `gclid`, `fbp`, `fbc`, `utm_source`, `utm_campaign`, `lead_event_id`
- [ ] **GTM Web** — Add hidden form fields to capture gclid, fbp, fbc → write to HubSpot

**Credentials collected:** `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_CLIENT_SECRET`

---

## Phase 6 — Snowflake (Day 2, ~15 min)

- [ ] **Snowflake** — Note Account Identifier (username menu → Account)
- [ ] **Snowflake** — Run `snowflake-setup.sql` as ACCOUNTADMIN
- [ ] **Snowflake** — Replace `<YOUR-STRONG-PASSWORD>` in the script before running
- [ ] **Snowflake** — Note credentials for `svc_martech` service user
- [ ] **Snowflake** — Test connection: run verification queries at bottom of setup script

**Credentials collected:** `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_USERNAME`, `SNOWFLAKE_PASSWORD`, `SNOWFLAKE_*`

---

## Phase 7 — Final Wiring (Day 3, ~30 min)

- [ ] **`.env`** — Fill all variables from `.env.template` with collected credentials
- [ ] **`.gitignore`** — Confirm `.env` is listed (check with `git status` before committing)
- [ ] **GitHub Secrets** — Add all variables as Repository Secrets for the Actions workflow
- [ ] **GTM Server** — In Stape/GTM, configure each server-side tag (GA4, Meta CAPI, Google Ads, LinkedIn) using the credentials
- [ ] **Test run** — Trigger a test form submission → verify in GTM Preview → check each platform's test event tools
- [ ] **Meta** — Events Manager → Test Events → verify CAPI receives events and deduplication works
- [ ] **Google Ads** — Conversions → Diagnostics → confirm test conversions received
- [ ] **Remove** `META_TEST_CODE` from production `.env`

---

## Verification Commands

```bash
# Check .env is not tracked by git
git status  # .env should not appear

# Run discrepancy audit with test data
node src/tracking-debugger/discrepancy-audit.js

# Dry-run audience sync (no actual upload)
DRY_RUN=true node src/audience-pipeline/audience-sync.js
```

---

## Estimated Total Time

| Phase | Time |
|---|---|
| Phase 1 (Stape + GTM) | 30 min |
| Phase 2 (GA4 + Google Ads) | 20 min |
| Phase 3 (Meta) | 20 min |
| Phase 4 (LinkedIn) | 20 min |
| Phase 5 (HubSpot) | 20 min |
| Phase 6 (Snowflake) | 15 min |
| Phase 7 (Final wiring + testing) | 30 min |
| **Total** | **~2.5 hours** |

DNS propagation for Stape custom domain (step 1) can take up to 24 hours —
start Phase 1 first, then work through the other platforms while DNS propagates.
