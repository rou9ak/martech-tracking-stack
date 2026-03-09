# Offline Conversions Setup Guide

Offline conversions close the attribution loop between your ad spend and real business outcomes. Without them, Google Ads and Meta optimise for top-of-funnel form fills — many of which never close. With them, platforms see which clicks actually became revenue and adjust bidding accordingly.

---

## Prerequisites

- HubSpot CRM with lifecycle stages configured
- Google Ads account with Enhanced Conversions enabled
- Meta Business Manager with Offline Conversions dataset created
- LinkedIn Campaign Manager with Conversions API access
- A server that can receive HubSpot webhooks (Node.js / Lambda / Cloud Run)

---

## Step 1: HubSpot Webhook Configuration

In HubSpot: **Settings → Integrations → Private Apps → Create App**

Subscribe to:
- `contact.propertyChange` — filter on property: `lifecyclestage`

**Webhook URL:** `https://your-server.com/webhooks/hubspot/lifecycle`

**Signature verification** — always verify. HubSpot sends `X-HubSpot-Signature-v3`. Verify with HMAC-SHA256 using your app's client secret:

```javascript
const expected = crypto
  .createHmac('sha256', process.env.HUBSPOT_CLIENT_SECRET)
  .update(rawBody)  // raw string body, not parsed JSON
  .digest('base64');

// Use timing-safe comparison to prevent timing attacks
const valid = crypto.timingSafeEqual(
  Buffer.from(incomingSignature),
  Buffer.from(expected)
);
```

---

## Step 2: Capturing GCLID at Lead Creation

Google Ads match rate is significantly higher with GCLID than email-only matching. Capture it at form submission:

**Hidden form field:**
```html
<input type="hidden" name="gclid" id="gclid_field" />
<script>
  // Read GCLID from URL param (set by Google Ads auto-tagging)
  const urlParams = new URLSearchParams(window.location.search);
  const gclid = urlParams.get('gclid');
  if (gclid) {
    document.getElementById('gclid_field').value = gclid;
    // Also persist to sessionStorage for multi-page forms
    sessionStorage.setItem('gclid', gclid);
  }
  // Fallback: read from sessionStorage
  if (!gclid && sessionStorage.getItem('gclid')) {
    document.getElementById('gclid_field').value = sessionStorage.getItem('gclid');
  }
</script>
```

**Store on HubSpot contact** via a custom property `gclid`. Reference this in the offline conversion upload.

---

## Step 3: Google Ads Offline Conversions

### Enable Enhanced Conversions

In Google Ads: **Goals → Conversions → Settings → Enhanced conversions for leads**

This allows email-based matching when GCLID is unavailable (organic, direct, other paid channels).

### Conversion Action Setup

Create one conversion action per lifecycle stage you want to track:

| Conversion Action Name | Category | Attribution Model |
|---|---|---|
| `crm_lead` | Lead | Data-driven |
| `crm_mql` | Qualified lead | Data-driven |
| `crm_sql` | Qualified lead | Data-driven |
| `crm_closed_won` | Purchase | Data-driven |

**Attribution window:** Set to 90 days for SaaS (typical lead-to-close cycle).

### Upload Format

```javascript
{
  conversionAction: `customers/${CUSTOMER_ID}/conversionActions/${ACTION_ID}`,
  conversionDateTime: "2024-03-15 14:22:00+00:00",  // must be exact format
  conversionValue: 12000,
  currencyCode: "USD",
  orderId: "DEAL-001",  // deduplication key — same deal_id = same conversion
  gclid: "CjwKCAjw...",  // preferred match key
  // OR
  userIdentifiers: [{ hashedEmail: "sha256_hex_string" }]
}
```

---

## Step 4: Meta Offline Conversions

### Dataset Setup

In Meta Events Manager: **Data Sources → Add → Offline Event Set**

Note your `dataset_id` — this is the upload target.

### Upload Format

```javascript
POST https://graph.facebook.com/v18.0/{dataset_id}/events

{
  "access_token": "...",
  "upload_tag": "crm-mql-2024-03-15",  // for grouping in Events Manager UI
  "data": [{
    "event_name": "QualifiedLead",
    "event_time": 1710511320,  // Unix timestamp
    "event_id": "DEAL-001-mql",  // dedup key
    "action_source": "crm",
    "user_data": {
      "em": ["sha256_of_email"],
      "ph": ["sha256_of_phone"],
      "fn": ["sha256_of_firstname"],
      "ln": ["sha256_of_lastname"]
    },
    "custom_data": {
      "value": 12000,
      "currency": "USD",
      "order_id": "DEAL-001"
    }
  }]
}
```

**Matching quality:** Meta uses a combination of all `user_data` fields. Providing email + phone + name typically achieves 65–75% match rate. Email alone is ~45–55%.

---

## Step 5: LinkedIn Conversions API

### Conversion Setup

In LinkedIn Campaign Manager: **Analyze → Conversion tracking → Create conversion**
Select "API" as the conversion method.

```javascript
POST https://api.linkedin.com/rest/conversionEvents

Headers:
  LinkedIn-Version: 202401
  Authorization: Bearer {access_token}

Body:
{
  "conversion": "urn:li:conversion:{conversion_id}",
  "conversionHappenedAt": 1710511320000,  // milliseconds
  "eventId": "DEAL-001-mql",
  "user": {
    "userIds": [{
      "idType": "SHA256_EMAIL",
      "idValue": "sha256_of_email"
    }]
  },
  "conversionValue": {
    "amount": "12000",
    "currencyCode": "USD"
  }
}
```

**Note on LinkedIn match rates:** Expect 40–60%. LinkedIn's matching is email-only (unlike Meta which uses multiple signals). Lower volume, higher match threshold for useful signal.

---

## Deduplication Strategy

Each upload must include a stable `orderId` / `event_id` / `eventId` field tied to the CRM deal. If the webhook fires twice (retries, re-processing), the same deal ID prevents double-counting on the platform side.

**HubSpot webhook retries:** HubSpot retries failed webhooks. Your handler must be idempotent. A simple Redis or DynamoDB dedup check on `deal_id + stage` prevents double uploads.

```javascript
const dedupKey = `${dealId}:${lifecycleStage}`;
const alreadyProcessed = await redis.get(dedupKey);
if (alreadyProcessed) return { skipped: true };

// ... process upload ...

await redis.setex(dedupKey, 86400 * 30, '1');  // 30 day TTL
```

---

## Validating Uploads

**Google Ads:** In the Conversions UI, click the conversion action → "Diagnostics" → look for "Uploaded and processed" status. Allow 24–48 hours for conversions to appear.

**Meta:** Events Manager → your dataset → "Event Match Quality" tab. Target EMQ score of 7+ out of 10.

**LinkedIn:** Campaign Manager → Conversion tracking → inspect the conversion. Shows "Active" once events are received.
