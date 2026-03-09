# GTM Server-Side Architecture

## Why Server-Side?

Browser-side tracking has three compounding failure modes:

1. **Ad blockers** — uBlock Origin, Brave, and privacy-focused browsers block GA4, Meta Pixel, and Google Ads tags by domain. Penetration among tech-savvy B2B audiences (the exact people you're targeting) is 40%+.
2. **ITP (Intelligent Tracking Prevention)** — Safari caps first-party cookies written by JavaScript at 7 days. This breaks session attribution for any user who doesn't convert in the same week.
3. **Client-side credential exposure** — pixel IDs, measurement IDs, and conversion labels are visible in the browser. Server-side tokens (API secrets, access tokens) cannot safely live in browser code.

Server-side GTM solves all three.

---

## Two-Container Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                 │
│                                                          │
│  dataLayer.push({ event: 'lead_form_submit', ... })      │
│       │                                                  │
│  GTM Web Container (gtm.js loaded from browser)         │
│       │                                                  │
│  Google Tag  ──────────────────────────────────────────►│
│    transport_url: https://collect.yourdomain.com         │
└───────────────────────────┬─────────────────────────────┘
                            │  HTTPS POST /collect
                            ▼
┌─────────────────────────────────────────────────────────┐
│  Stape Server Container  (your domain, your server)     │
│                                                          │
│  GA4 Client  ←── parses incoming event                  │
│       │                                                  │
│       ├──► GA4 Tag  ──► GA4 Measurement Protocol API    │
│       │                  (uses GA4_API_SECRET)           │
│       │                                                  │
│       ├──► Meta CAPI Tag ──► graph.facebook.com/events   │
│       │                      (uses META_CAPI_TOKEN)      │
│       │                                                  │
│       ├──► Google Ads Tag ──► Google Ads Conversion API  │
│       │                       (GCLID or email match)     │
│       │                                                  │
│       └──► LinkedIn Tag ──► api.linkedin.com/rest/...    │
│                              (SHA-256 email)             │
└─────────────────────────────────────────────────────────┘
```

The key architectural choice: **the Web Container fires only one tag** — the Google Tag configured with your server container's `transport_url`. All downstream tag logic lives on the server. This means:

- Ad blockers that block `google-analytics.com` or `facebook.net` don't affect collection — your server container uses first-party subdomain routing
- API credentials (GA4 API secret, Meta access token) never appear in browser-visible network requests
- You control retry logic, batching, and error handling centrally

---

## Stape Configuration

[Stape](https://stape.io) is the recommended hosting provider for GTM Server containers. Key configuration steps:

### 1. Custom Domain Setup

```
collect.yourdomain.com  →  Stape CNAME target
```

Use a subdomain of your own domain — this is what makes the first-party cookie bypass work. `collect.yourdomain.com` is treated as same-site by browsers; `googletagmanager.com` is not.

### 2. Web Container: Google Tag Configuration

In your GTM Web container, configure the Google Tag:
- **Tag ID:** Your GA4 Measurement ID (G-XXXXXXXXXX)
- **Configuration settings → transport_url:** `https://collect.yourdomain.com`
- **server_container_url:** same value

This routes all events from the web container to your server container instead of directly to Google's servers.

### 3. Cookie Forwarding

For Meta CAPI, `fbp` and `fbc` cookies must be forwarded from the browser to the server container. In the Stape UI, enable:

- **Cookie forwarding:** `_fbp`, `_fbc`, `_gcl_aw` (Google Click ID)
- **IP forwarding:** Enable — Meta uses IP for matching

---

## Event Schema Enforcement

Every event is validated against the canonical schema before routing:

```javascript
// Required fields — rejection if missing
const required = ['event_name', 'timestamp_ms', 'client_id', 'session_id'];

// Optional but used for matching
const optional = ['user_id', 'email_hash', 'phone_hash', 'gclid',
                  'fbp', 'fbc', 'utm_source', 'utm_campaign', ...];
```

Events that fail validation are logged and rejected — they never reach ad platforms. This prevents bad data from inflating conversion counts.

---

## Meta CAPI Deduplication

Running both browser pixel and CAPI creates double-counting without explicit deduplication.

**The correct pattern:**

```javascript
// 1. Generate event_id ONCE in the dataLayer push (browser)
window.dataLayer.push({
  event: 'lead_form_submit',
  event_id: crypto.randomUUID(),  // one stable ID per event
  // ...
});

// 2. Browser pixel fires with this event_id
// fbq('track', 'Lead', {}, { eventID: event_id });

// 3. GTM Server reads event_id from incoming payload
// forwards it as-is to Meta CAPI

// 4. Meta sees both with same event_id → counts as 1 conversion
```

**Common mistake:** Generating a new UUID server-side. If the browser pixel fires with `event_id: "abc"` and CAPI fires with `event_id: "xyz"`, Meta counts two conversions.

**Testing deduplication:** In Meta Events Manager → Test Events, you can verify that browser + CAPI events with the same `event_id` appear as a single deduplicated event (not two).

---

## PII Handling

No raw PII should ever reach this layer. The hashing strategy:

```
Browser layer:
  - dataLayer receives form.email — hashed immediately before push
  - Raw email NEVER enters dataLayer

Server layer:
  - If email_hash arrives, it's forwarded directly
  - If (incorrectly) raw email arrives, server hashes it and logs a warning
  - Raw email is NEVER logged, stored, or forwarded

Ad platform APIs:
  - Receive SHA-256 hex strings only
  - Meta: normalise to lowercase, trim whitespace BEFORE hashing
  - Google: same normalisation
  - LinkedIn: same normalisation
```

Normalisation before hashing is critical — `User@Example.com` and `user@example.com` hash to different values. A mismatch in normalisation between your hash and the ad platform's hash = zero matches.
