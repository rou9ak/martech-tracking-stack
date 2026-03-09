# Tracking Discrepancy Debugging Playbook

A systematic approach to diagnosing why your numbers don't match. Work through the checks in order — most discrepancies are resolved by step 3.

---

## Before You Start

Establish your baseline:

```bash
node src/tracking-debugger/discrepancy-audit.js
```

This runs all cross-system comparisons and prints a severity-ranked report. Use it to triage before diving in.

Acceptable variance thresholds:

| Comparison | Acceptable | Investigate | Critical |
|---|---|---|---|
| GA4 vs Google Ads | < 5% | 5–15% | > 30% |
| Meta Pixel vs CAPI | < 10% | 10–25% | > 40% |
| CRM vs ad platform | n/a (ad platform always lower) | — | Ad platform > CRM |
| GTM Server vs GA4 | < 3% | 3–10% | > 20% |

---

## Scenario 1: GA4 Shows More Conversions Than Google Ads

**Likely causes, in order of frequency:**

### 1a. Attribution model mismatch
GA4 uses event-scoped attribution by default. Google Ads uses last-click (or data-driven if enabled). A user who visited via paid search, left, came back via direct, and converted will appear in GA4 under "direct" but in Google Ads under the original paid click.

**Fix:** In GA4, set your conversion reporting attribution model to match Google Ads. Go to Admin → Attribution Settings → Reporting attribution model → Data-driven (or last click, to match GAds).

### 1b. Cross-device conversions
Google Ads uses Signed-In Google accounts to connect mobile clicks to desktop conversions. GA4 doesn't have this by default unless you've set `user_id`.

**Fix:** Implement `user_id` in GA4 using your auth system. Pass the same `user_id` to both GA4 and Google Ads Enhanced Conversions.

### 1c. Duplicate transaction_ids in GA4
If a user refreshes the confirmation page, GA4 fires `purchase` twice. Without deduplication on `transaction_id`, both count.

**Debug:** In BigQuery:
```sql
SELECT transaction_id, COUNT(*) as fires
FROM `analytics_XXXXXX.events_*`
WHERE event_name = 'purchase'
  AND _TABLE_SUFFIX >= '20240101'
GROUP BY 1
HAVING COUNT(*) > 1
ORDER BY 2 DESC
LIMIT 20;
```

**Fix:** GA4 deduplicates `purchase` events by `transaction_id` natively — but only if the field is sent. Verify your GTM tag is passing `transaction_id` (not empty/undefined).

### 1d. View-through conversions in Google Ads
By default, Google Ads counts view-through conversions (user saw an ad, didn't click, later converted). GA4 has no equivalent.

**Fix:** In Google Ads → Conversions → edit the conversion action → set "View-through conversion window" to 0 days (or 1 day for brand awareness) for direct-response campaigns.

---

## Scenario 2: Meta Reports 2× More Conversions Than Expected

**Almost always:** CAPI + browser pixel firing without deduplication.

**Verify:** In Meta Events Manager → your pixel → Events → filter to your conversion event → look at the "Deduplicated" column. If it shows ~50% deduplication rate, both are firing but `event_id` isn't matching.

**Debug steps:**

1. Open browser DevTools → Network → filter `facebook.net`
2. Trigger a test conversion
3. Find the pixel request → check `eid` parameter (this is `event_id`)
4. In GTM Preview Mode → Server container → outgoing Meta CAPI request → find `event_id` in payload

If the two values don't match, your `event_id` is being regenerated server-side instead of forwarded.

**Fix:**
```javascript
// ❌ WRONG — server generates new ID
const payload = { event_id: crypto.randomUUID(), ... };

// ✅ CORRECT — forward the ID from the browser
const payload = { event_id: incomingEvent.event_id, ... };
```

---

## Scenario 3: Ad Platform Shows MORE Conversions Than CRM

This is the most serious discrepancy — it means you're uploading duplicate or phantom conversions.

**Causes:**

### 3a. Webhook retries creating duplicates
HubSpot retries failed webhooks. If your handler returns a non-200 status (timeout, error), HubSpot retries — and you upload the same conversion twice.

**Fix:** Return 200 immediately on webhook receipt, process async. Add idempotency check on `deal_id + lifecycle_stage` before uploading.

### 3b. Multiple deals per contact
If a contact has 3 deals and all reach `closed_won`, you upload 3 conversions. The ad platform has no way to know they're the same person.

**Fix:** In your enrichment step, check if the contact already has a previous `closed_won` conversion uploaded. Only upload the first, or use a contact-level dedup key instead of deal-level.

### 3c. Test conversions not filtered
If you ran test events in staging against production ad account IDs.

**Fix:** In Google Ads, delete test conversions manually. In Meta Events Manager, check upload history and identify test upload tags.

---

## Scenario 4: GTM Server Receiving Fewer Events Than GA4 Browser

The server container should see ≥ as many events as GA4 browser (it fires even when the browser GA4 tag would have been blocked). If it's seeing fewer, the transport URL isn't reaching all pageviews.

**Debug:**

1. **GTM Preview Mode** → Server container → check incoming requests
2. **Stape dashboard** → request volume graph — does it match GA4 session count?
3. **Check transport URL coverage** — is the Google Tag present on ALL pages, or just some?

```javascript
// Common mistake: Google Tag only on conversion pages
// Result: server container only sees conversion events, misses page views

// Correct: Google Tag on ALL pages via GTM trigger "All Pages"
```

4. **Check for 5xx errors** in Stape logs — server container crashes lose events silently from the GA4 perspective (browser thinks the hit was sent).

---

## Scenario 5: LinkedIn Reporting 10× More Conversions

LinkedIn's default view-through window is 30 days. For B2B SaaS with long sales cycles, almost every closed deal will be attributed to a LinkedIn impression someone saw a month ago.

**Fix:** In LinkedIn Campaign Manager → Conversions → edit → set:
- Click-through window: 30 days (fine)
- View-through window: 7 days maximum (or 0 for bottom-funnel conversions)

---

## Single Event Trace

For investigating a specific event that should have been tracked but wasn't:

```javascript
const { traceEventEnd2End } = require('./src/tracking-debugger/discrepancy-audit.js');

// Trace a specific event_id across all systems
const trace = await traceEventEnd2End('your-event-id-here');
console.log(trace);
```

Output shows exactly which systems received the event and which didn't, with timestamps and relevant identifiers.

---

## Preventative Monitoring

Run the discrepancy audit on a schedule:

```yaml
# .github/workflows/tracking-audit.yml
- cron: '0 9 * * 1'  # Every Monday at 9am
```

The audit outputs JSON. Pipe it to a Slack webhook to get weekly variance reports automatically. Catch drift before it compounds.
