/**
 * GTM Server-Side Container Configuration
 * Marketing Tracking Stack — Full-Funnel Event Handling
 *
 * Architecture:
 *   Client (Browser) → GTM Web → GTM Server (Stape-hosted) → Ad Platforms
 *                                                            → GA4
 *                                                            → CRM Webhook
 */

'use strict';

// ─── Event Schema (canonical) ────────────────────────────────────────────────

const EVENT_SCHEMA = {
  // All events must conform to this shape before forwarding
  required: ['event_name', 'timestamp_ms', 'client_id', 'session_id'],
  optional: ['user_id', 'email_hash', 'phone_hash', 'page_url', 'referrer',
             'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
             'currency', 'value', 'transaction_id', 'items'],

  events: {
    page_view:         { triggers: ['GTM-PAGE-VIEW'], destinations: ['GA4', 'Meta'] },
    lead_form_submit:  { triggers: ['GTM-FORM-SUBMIT'], destinations: ['GA4', 'Meta', 'Google', 'LinkedIn'] },
    demo_requested:    { triggers: ['GTM-DEMO-CLICK'], destinations: ['GA4', 'Meta', 'Google', 'LinkedIn'] },
    trial_started:     { triggers: ['GTM-TRIAL-START'], destinations: ['GA4', 'Meta', 'Google'] },
    purchase:          { triggers: ['GTM-PURCHASE'], destinations: ['GA4', 'Meta', 'Google'] },
    offline_conversion:{ triggers: ['CRM-WEBHOOK'],  destinations: ['Google', 'Meta', 'LinkedIn'] },
  }
};

// ─── Server-Side Tag: GA4 Forwarding ─────────────────────────────────────────

const ga4ServerTag = {
  tagId: 'TAG-GA4-SERVER',
  type: 'Google Analytics: GA4',
  config: {
    measurement_id: '{{GA4_MEASUREMENT_ID}}',
    api_secret: '{{GA4_API_SECRET}}',   // server-side only — never exposed client-side
    endpoint: 'https://www.google-analytics.com/mp/collect',
  },
  eventMapping: (incomingEvent) => ({
    client_id: incomingEvent.client_id,
    user_id:   incomingEvent.user_id || undefined,
    events: [{
      name:   incomingEvent.event_name,
      params: {
        session_id:     incomingEvent.session_id,
        engagement_time_msec: 100,
        page_location:  incomingEvent.page_url,
        source:         incomingEvent.utm_source,
        medium:         incomingEvent.utm_medium,
        campaign:       incomingEvent.utm_campaign,
        value:          incomingEvent.value,
        currency:       incomingEvent.currency || 'USD',
        transaction_id: incomingEvent.transaction_id,
      }
    }]
  })
};

// ─── Server-Side Tag: Meta CAPI ───────────────────────────────────────────────

const metaCAPITag = {
  tagId: 'TAG-META-CAPI',
  type: 'Meta Conversions API',
  config: {
    pixel_id:    '{{META_PIXEL_ID}}',
    access_token:'{{META_CAPI_TOKEN}}',   // server-side only
    test_event_code: '{{META_TEST_CODE}}', // remove in production
    endpoint: 'https://graph.facebook.com/v18.0/{{META_PIXEL_ID}}/events',
  },
  // Deduplication: send both browser pixel & CAPI with same event_id
  eventMapping: (incomingEvent) => ({
    data: [{
      event_name:       metaEventName(incomingEvent.event_name),
      event_time:       Math.floor(incomingEvent.timestamp_ms / 1000),
      event_id:         incomingEvent.event_id,  // for dedup with browser pixel
      event_source_url: incomingEvent.page_url,
      action_source:    'website',
      user_data: {
        em:  incomingEvent.email_hash,   // SHA-256 hashed
        ph:  incomingEvent.phone_hash,   // SHA-256 hashed
        fbp: incomingEvent.fbp,
        fbc: incomingEvent.fbc,
        client_ip_address: incomingEvent.ip_address,
        client_user_agent: incomingEvent.user_agent,
      },
      custom_data: {
        value:    incomingEvent.value,
        currency: incomingEvent.currency || 'USD',
        order_id: incomingEvent.transaction_id,
      }
    }]
  })
};

function metaEventName(canonicalName) {
  const map = {
    page_view:        'PageView',
    lead_form_submit: 'Lead',
    demo_requested:   'Lead',
    trial_started:    'StartTrial',
    purchase:         'Purchase',
  };
  return map[canonicalName] || 'CustomEvent';
}

// ─── Server-Side Tag: Google Ads Conversion ───────────────────────────────────

const googleAdsTag = {
  tagId: 'TAG-GADS-SERVER',
  type: 'Google Ads Conversion Tracking',
  config: {
    conversion_id:    '{{GADS_CONVERSION_ID}}',
    conversion_label: '{{GADS_CONVERSION_LABEL}}',
  },
  eventMapping: (incomingEvent) => ({
    conversion_action: `customers/{{GADS_CUSTOMER_ID}}/conversionActions/{{GADS_ACTION_ID}}`,
    conversion_date_time: new Date(incomingEvent.timestamp_ms).toISOString(),
    conversion_value:  incomingEvent.value,
    currency_code:     incomingEvent.currency || 'USD',
    order_id:          incomingEvent.transaction_id,
    gclid:             incomingEvent.gclid,
    user_identifiers: [{
      hashed_email: incomingEvent.email_hash,
    }]
  })
};

// ─── Server-Side Tag: LinkedIn Insight ───────────────────────────────────────

const linkedInTag = {
  tagId: 'TAG-LI-SERVER',
  type: 'LinkedIn Conversions API',
  config: {
    partner_id:   '{{LI_PARTNER_ID}}',
    access_token: '{{LI_ACCESS_TOKEN}}',
    endpoint: 'https://api.linkedin.com/rest/conversionEvents',
  },
  eventMapping: (incomingEvent) => ({
    conversion: `urn:li:conversion:{{LI_CONVERSION_ID}}`,
    conversionHappenedAt: incomingEvent.timestamp_ms,
    user: {
      userIds: [
        { idType: 'SHA256_EMAIL', idValue: incomingEvent.email_hash }
      ],
      userInfo: {
        firstName: incomingEvent.first_name_hash,
        lastName:  incomingEvent.last_name_hash,
        title:     incomingEvent.job_title,
        companyName: incomingEvent.company,
      }
    },
    eventId: incomingEvent.event_id,
    conversionValue: {
      amount:       String(incomingEvent.value || 0),
      currencyCode: incomingEvent.currency || 'USD',
    }
  })
};

// ─── Router: Event Fanout ─────────────────────────────────────────────────────

async function routeEvent(rawEvent) {
  const event = validateAndNormalise(rawEvent);
  if (!event.valid) {
    console.error('[GTM-SERVER] Invalid event rejected:', event.errors);
    return { status: 'rejected', errors: event.errors };
  }

  const schema  = EVENT_SCHEMA.events[event.event_name];
  if (!schema) {
    console.warn('[GTM-SERVER] Unknown event, forwarding to GA4 only:', event.event_name);
    await forwardToDestination('GA4', event);
    return { status: 'partial' };
  }

  const results = await Promise.allSettled(
    schema.destinations.map(dest => forwardToDestination(dest, event))
  );

  return {
    status: 'ok',
    event:  event.event_name,
    destinations: results.map((r, i) => ({
      dest:   schema.destinations[i],
      status: r.status,
      error:  r.reason?.message
    }))
  };
}

function validateAndNormalise(raw) {
  const errors = [];
  EVENT_SCHEMA.required.forEach(field => {
    if (!raw[field]) errors.push(`Missing required field: ${field}`);
  });
  if (errors.length) return { valid: false, errors };

  return {
    valid: true,
    ...raw,
    // Normalise
    event_name:  raw.event_name.toLowerCase().replace(/\s+/g, '_'),
    timestamp_ms: raw.timestamp_ms || Date.now(),
    // PII hashing guard: reject plaintext email
    email_hash: raw.email_hash || (raw.email ? hashPII(raw.email) : undefined),
    phone_hash: raw.phone_hash || (raw.phone ? hashPII(raw.phone) : undefined),
  };
}

function hashPII(value) {
  // In production: use crypto.subtle.digest('SHA-256', ...)
  // Placeholder — never log or persist raw PII
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

async function forwardToDestination(dest, event) {
  // In production each of these calls the respective tag's fetch
  const handlers = { GA4: ga4ServerTag, Meta: metaCAPITag, Google: googleAdsTag, LinkedIn: linkedInTag };
  const tag = handlers[dest];
  if (!tag) throw new Error(`Unknown destination: ${dest}`);

  const payload = tag.eventMapping(event);
  console.log(`[GTM-SERVER] → ${dest}:`, event.event_name);
  // return await fetch(tag.config.endpoint, { method: 'POST', body: JSON.stringify(payload) });
  return { dest, payload }; // stubbed for demo
}

module.exports = { routeEvent, EVENT_SCHEMA, validateAndNormalise, hashPII };
