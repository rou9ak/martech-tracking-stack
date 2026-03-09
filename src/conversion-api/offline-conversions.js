/**
 * Conversion API — Offline & Enhanced Conversions Pipeline
 *
 * Handles:
 *  1. Google Ads Enhanced Conversions (GCLID-based)
 *  2. Meta Offline Conversions (from CRM lead stages)
 *  3. LinkedIn Offline Conversions (from CRM pipeline)
 *
 * Data flow:
 *   CRM (HubSpot/Salesforce) → Webhook → This service → Ad Platform APIs
 */

'use strict';

const crypto = require('crypto');

// ─── CRM Lead Stage → Conversion Action Mapping ──────────────────────────────

const CRM_STAGE_MAP = {
  // HubSpot lifecycle stages → Google Ads conversion actions
  google: {
    'subscriber':       null,                   // not a conversion
    'lead':             'CONV_LEAD',
    'marketingqualified':'CONV_MQL',
    'salesqualified':   'CONV_SQL',
    'opportunity':      'CONV_OPP',
    'customer':         'CONV_CUSTOMER',
    'closed_won':       'CONV_CLOSED_WON',
  },
  // HubSpot lifecycle stages → Meta custom events
  meta: {
    'lead':             'Lead',
    'marketingqualified':'QualifiedLead',
    'salesqualified':   'SQLead',
    'customer':         'Purchase',
    'closed_won':       'Purchase',
  },
  // HubSpot lifecycle stages → LinkedIn conversion IDs
  linkedin: {
    'lead':             'LI_CONV_LEAD',
    'marketingqualified':'LI_CONV_MQL',
    'customer':         'LI_CONV_CUSTOMER',
  }
};

// ─── Google Ads Offline Conversion Upload ─────────────────────────────────────

async function uploadGoogleOfflineConversion(leadRecord) {
  const conversionAction = CRM_STAGE_MAP.google[leadRecord.lifecycle_stage];
  if (!conversionAction) {
    return { skipped: true, reason: `No Google mapping for stage: ${leadRecord.lifecycle_stage}` };
  }
  if (!leadRecord.gclid && !leadRecord.email) {
    return { skipped: true, reason: 'No GCLID or email for matching' };
  }

  const payload = {
    conversions: [{
      conversionAction: `customers/${process.env.GADS_CUSTOMER_ID}/conversionActions/${conversionAction}`,
      conversionDateTime: formatGoogleDateTime(leadRecord.stage_changed_at),
      conversionValue:    leadRecord.deal_value || 0,
      currencyCode:       'USD',
      orderId:            leadRecord.deal_id,
      // Enhanced — match by GCLID if available, else by email
      ...(leadRecord.gclid
        ? { gclid: leadRecord.gclid }
        : { userIdentifiers: [{ hashedEmail: hashSHA256(leadRecord.email) }] }
      ),
    }],
    partialFailure: true,
  };

  console.log('[GADS-OFFLINE] Uploading conversion:', conversionAction, leadRecord.deal_id);
  // const response = await googleAdsClient.offlineUserDataJobs.create(payload);
  return { platform: 'google', action: conversionAction, payload };
}

// ─── Meta Offline Conversions Upload ─────────────────────────────────────────

async function uploadMetaOfflineConversion(leadRecord) {
  const eventName = CRM_STAGE_MAP.meta[leadRecord.lifecycle_stage];
  if (!eventName) {
    return { skipped: true, reason: `No Meta mapping for stage: ${leadRecord.lifecycle_stage}` };
  }

  const userDataFields = {};
  if (leadRecord.email)      userDataFields.em  = [hashSHA256(leadRecord.email.trim().toLowerCase())];
  if (leadRecord.phone)      userDataFields.ph  = [hashSHA256(normalisePhone(leadRecord.phone))];
  if (leadRecord.first_name) userDataFields.fn  = [hashSHA256(leadRecord.first_name.trim().toLowerCase())];
  if (leadRecord.last_name)  userDataFields.ln  = [hashSHA256(leadRecord.last_name.trim().toLowerCase())];
  if (leadRecord.country)    userDataFields.ct  = [hashSHA256(leadRecord.country.trim().toLowerCase())];

  const payload = {
    access_token: process.env.META_OFFLINE_TOKEN,
    upload_tag:   `crm-${leadRecord.lifecycle_stage}-${Date.now()}`,
    data: [{
      event_name:  eventName,
      event_time:  Math.floor(new Date(leadRecord.stage_changed_at).getTime() / 1000),
      event_id:    `${leadRecord.deal_id}-${leadRecord.lifecycle_stage}`,
      action_source: 'crm',
      user_data:   userDataFields,
      custom_data: {
        value:    leadRecord.deal_value,
        currency: 'USD',
        order_id: leadRecord.deal_id,
      }
    }]
  };

  const endpoint = `https://graph.facebook.com/v18.0/${process.env.META_DATASET_ID}/events`;
  console.log('[META-OFFLINE] Uploading conversion:', eventName, leadRecord.deal_id);
  // const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
  return { platform: 'meta', event: eventName, payload };
}

// ─── LinkedIn Offline Conversions ─────────────────────────────────────────────

async function uploadLinkedInOfflineConversion(leadRecord) {
  const conversionUrn = CRM_STAGE_MAP.linkedin[leadRecord.lifecycle_stage];
  if (!conversionUrn) {
    return { skipped: true, reason: `No LinkedIn mapping for stage: ${leadRecord.lifecycle_stage}` };
  }

  const payload = {
    conversion: `urn:li:conversion:${process.env[conversionUrn]}`,
    conversionHappenedAt: new Date(leadRecord.stage_changed_at).getTime(),
    eventId: `${leadRecord.deal_id}-${leadRecord.lifecycle_stage}`,
    user: {
      userIds: [
        ...(leadRecord.email ? [{ idType: 'SHA256_EMAIL', idValue: hashSHA256(leadRecord.email) }] : []),
        ...(leadRecord.linkedin_id ? [{ idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID', idValue: leadRecord.linkedin_id }] : []),
      ],
      userInfo: {
        companyName: leadRecord.company,
        title:       leadRecord.job_title,
      }
    },
    conversionValue: {
      amount:       String(leadRecord.deal_value || 0),
      currencyCode: 'USD',
    }
  };

  console.log('[LI-OFFLINE] Uploading conversion:', conversionUrn, leadRecord.deal_id);
  return { platform: 'linkedin', conversion: conversionUrn, payload };
}

// ─── CRM Webhook Handler ───────────────────────────────────────────────────────

async function handleCRMWebhook(webhookPayload) {
  // Validate webhook signature (HubSpot HMAC)
  const sig = webhookPayload.headers['x-hubspot-signature-v3'];
  if (!verifyHubSpotSignature(sig, webhookPayload.rawBody)) {
    throw new Error('Invalid webhook signature');
  }

  const results = [];

  for (const event of webhookPayload.body) {
    if (event.subscriptionType !== 'contact.propertyChange') continue;
    if (event.propertyName !== 'lifecyclestage') continue;

    const leadRecord = await enrichFromCRM(event.objectId);
    if (!leadRecord) continue;

    // Fan out to all ad platforms in parallel
    const [google, meta, linkedin] = await Promise.allSettled([
      uploadGoogleOfflineConversion(leadRecord),
      uploadMetaOfflineConversion(leadRecord),
      uploadLinkedInOfflineConversion(leadRecord),
    ]);

    results.push({
      contact_id: event.objectId,
      stage:      leadRecord.lifecycle_stage,
      google:     google.value || google.reason,
      meta:       meta.value   || meta.reason,
      linkedin:   linkedin.value || linkedin.reason,
    });
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashSHA256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalisePhone(phone) {
  // E.164 normalisation: strip non-digits, add country code
  const digits = phone.replace(/\D/g, '');
  return digits.startsWith('1') ? digits : `1${digits}`;
}

function formatGoogleDateTime(isoString) {
  // Google Ads requires: "2024-01-15 10:30:00-05:00"
  const d = new Date(isoString);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}+00:00`;
}

function verifyHubSpotSignature(signature, rawBody) {
  const expected = crypto
    .createHmac('sha256', process.env.HUBSPOT_CLIENT_SECRET)
    .update(rawBody)
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function enrichFromCRM(contactId) {
  // Fetch full contact from HubSpot to get all needed fields
  // const contact = await hubspotClient.crm.contacts.basicApi.getById(contactId, [...fields]);
  // Stub:
  return {
    contact_id:      contactId,
    email:           'lead@example.com',
    phone:           '+14155551234',
    first_name:      'Jane',
    last_name:       'Smith',
    company:         'Acme Corp',
    job_title:       'VP Marketing',
    lifecycle_stage: 'marketingqualified',
    stage_changed_at:'2024-03-15T14:22:00Z',
    gclid:           'CjwKCAjw....',
    deal_id:         'DEAL-001',
    deal_value:      12000,
  };
}

module.exports = {
  handleCRMWebhook,
  uploadGoogleOfflineConversion,
  uploadMetaOfflineConversion,
  uploadLinkedInOfflineConversion,
  CRM_STAGE_MAP,
};
