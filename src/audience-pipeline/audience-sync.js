/**
 * Audience Sync Pipeline — CRM → Ad Platforms
 * Mirrors Hightouch-style architecture using dbt models + sync configs
 *
 * Components:
 *  - Source: Snowflake (dbt-transformed CRM + event data)
 *  - Destinations: Google Ads Customer Match, Meta Custom Audiences, LinkedIn Matched Audiences
 *  - Sync strategy: incremental, identity-resolved, PII-hashed
 */

'use strict';

// ─── Audience Definitions (mirror Hightouch model configs) ───────────────────

const AUDIENCE_MODELS = {

  high_intent_leads: {
    description: 'Leads who visited pricing page + submitted a form in last 30 days',
    sql: `
      SELECT
        c.contact_id,
        c.email,
        c.phone,
        c.first_name,
        c.last_name,
        c.company,
        c.country
      FROM dim_contacts c
      INNER JOIN fct_events e ON e.user_id = c.user_id
      WHERE
        c.lifecycle_stage IN ('lead', 'marketingqualified')
        AND e.event_name IN ('pricing_page_view', 'lead_form_submit')
        AND e.event_date >= CURRENT_DATE - INTERVAL '30 days'
        AND c.email IS NOT NULL
        AND c.is_unsubscribed = FALSE
      GROUP BY 1,2,3,4,5,6,7
    `,
    refresh_schedule: '0 */4 * * *',   // every 4 hours
    estimated_size:   12000,
  },

  closed_won_lookalike_seed: {
    description: 'All closed-won customers for lookalike audience seeding',
    sql: `
      SELECT
        c.contact_id,
        c.email,
        c.phone,
        c.first_name,
        c.last_name,
        c.company,
        c.country,
        c.job_title,
        d.arr_band,
        d.industry,
        d.company_size_band
      FROM dim_contacts c
      INNER JOIN dim_deals d ON d.contact_id = c.contact_id
      WHERE
        d.deal_stage = 'closed_won'
        AND d.close_date >= CURRENT_DATE - INTERVAL '365 days'
    `,
    refresh_schedule: '0 6 * * *',    // daily at 6am
    estimated_size:   3500,
  },

  active_trial_users: {
    description: 'Users currently in trial — suppress from prospecting, retarget with conversion ads',
    sql: `
      SELECT DISTINCT
        c.contact_id,
        c.email,
        c.phone,
        u.user_id,
        u.trial_start_date,
        u.trial_end_date
      FROM dim_contacts c
      INNER JOIN dim_users u ON u.email = c.email
      WHERE
        u.account_status = 'trial'
        AND u.trial_end_date >= CURRENT_DATE
    `,
    refresh_schedule: '0 */2 * * *',  // every 2 hours
    use_as_suppression: true,
    estimated_size: 800,
  },

  churned_customers_winback: {
    description: 'Churned customers within 180 days — winback campaign',
    sql: `
      SELECT
        c.contact_id,
        c.email,
        c.phone,
        c.first_name,
        c.last_name,
        c.company,
        d.last_arr,
        d.churn_reason_category
      FROM dim_contacts c
      INNER JOIN dim_deals d ON d.contact_id = c.contact_id
      WHERE
        d.deal_stage = 'churned'
        AND d.churn_date BETWEEN CURRENT_DATE - INTERVAL '180 days' AND CURRENT_DATE - INTERVAL '7 days'
        AND d.last_arr >= 5000  -- only meaningful ARR churns
    `,
    refresh_schedule: '0 8 * * *',
    estimated_size: 420,
  },
};

// ─── Destination Sync Configs ─────────────────────────────────────────────────

const DESTINATIONS = {

  google_ads: {
    type: 'Google Ads Customer Match',
    customer_id: process.env.GADS_CUSTOMER_ID,
    match_keys: ['email', 'phone', 'first_name', 'last_name', 'country'],
    hash_fields: ['email', 'phone', 'first_name', 'last_name'],
    hash_algo: 'SHA-256',
    normalisation: {
      email: v => v.trim().toLowerCase(),
      phone: v => `+1${v.replace(/\D/g, '')}`,
      first_name: v => v.trim().toLowerCase(),
      last_name:  v => v.trim().toLowerCase(),
    },
    audience_map: {
      high_intent_leads:           'GADS_LIST_HIGH_INTENT',
      closed_won_lookalike_seed:   'GADS_LIST_CLOSED_WON',
      active_trial_users:          'GADS_LIST_ACTIVE_TRIAL',
      churned_customers_winback:   'GADS_LIST_WINBACK',
    }
  },

  meta: {
    type: 'Meta Custom Audience',
    ad_account_id: process.env.META_AD_ACCOUNT_ID,
    match_keys: ['email', 'phone', 'first_name', 'last_name', 'country'],
    schema: ['EMAIL', 'PHONE', 'FN', 'LN', 'CT'],
    hash_algo: 'SHA-256',
    audience_map: {
      high_intent_leads:           'META_AUD_HIGH_INTENT',
      closed_won_lookalike_seed:   'META_AUD_CLOSED_WON',
      active_trial_users:          'META_AUD_ACTIVE_TRIAL',
      churned_customers_winback:   'META_AUD_WINBACK',
    }
  },

  linkedin: {
    type: 'LinkedIn Matched Audiences',
    account_id: process.env.LI_ACCOUNT_ID,
    match_keys: ['email'],
    hash_algo: 'SHA-256',
    audience_map: {
      high_intent_leads:         'LI_AUD_HIGH_INTENT',
      closed_won_lookalike_seed: 'LI_AUD_CLOSED_WON',
    }
  },
};

// ─── Sync Orchestrator ────────────────────────────────────────────────────────

class AudienceSyncPipeline {

  constructor(snowflakeClient, options = {}) {
    this.db      = snowflakeClient;
    this.dryRun  = options.dryRun  || false;
    this.verbose = options.verbose || false;
  }

  async syncAudience(audienceName, destinationNames = Object.keys(DESTINATIONS)) {
    const model = AUDIENCE_MODELS[audienceName];
    if (!model) throw new Error(`Unknown audience: ${audienceName}`);

    console.log(`[SYNC] Starting sync: ${audienceName}`);
    console.log(`[SYNC] Query: ${model.sql.trim().slice(0, 80)}...`);

    // 1. Pull from Snowflake
    const records = await this.fetchAudienceRecords(model.sql);
    console.log(`[SYNC] Fetched ${records.length} records from warehouse`);

    // 2. Data quality checks
    const qcResult = this.runDataQualityChecks(records, audienceName);
    if (!qcResult.passed) {
      throw new Error(`Data quality failed for ${audienceName}: ${qcResult.errors.join(', ')}`);
    }
    console.log(`[SYNC] QC passed — email match rate: ${qcResult.email_coverage}%`);

    // 3. Fan out to destinations
    const results = {};
    for (const destName of destinationNames) {
      const dest = DESTINATIONS[destName];
      if (!dest) { results[destName] = { error: 'Unknown destination' }; continue; }

      const listId = dest.audience_map[audienceName];
      if (!listId) { results[destName] = { skipped: 'No mapping' }; continue; }

      const payload = this.buildPayload(records, dest);
      results[destName] = await this.uploadToDestination(destName, dest, listId, payload);
    }

    return { audience: audienceName, records: records.length, qc: qcResult, destinations: results };
  }

  buildPayload(records, destConfig) {
    return records.map(row => {
      const hashed = {};
      for (const field of destConfig.match_keys) {
        if (!row[field]) continue;
        const normalised = destConfig.normalisation?.[field]
          ? destConfig.normalisation[field](row[field])
          : row[field];
        hashed[field] = this.hashSHA256(normalised);
      }
      return hashed;
    }).filter(r => Object.keys(r).length > 0);
  }

  runDataQualityChecks(records, audienceName) {
    const errors = [];
    const total  = records.length;

    if (total === 0) {
      errors.push('Empty audience — aborting to avoid clearing ad platform list');
      return { passed: false, errors };
    }

    const expectedSize = AUDIENCE_MODELS[audienceName].estimated_size;
    const deviation    = Math.abs(total - expectedSize) / expectedSize;
    if (deviation > 0.4) {
      errors.push(`Size deviation ${(deviation*100).toFixed(1)}% vs expected ${expectedSize} — possible data issue`);
    }

    const withEmail   = records.filter(r => r.email).length;
    const emailCoverage = Math.round((withEmail / total) * 100);
    if (emailCoverage < 60) {
      errors.push(`Low email coverage: ${emailCoverage}% (minimum 60%)`);
    }

    // Duplicate check
    const emails = records.map(r => r.email).filter(Boolean);
    const uniqueEmails = new Set(emails).size;
    if (uniqueEmails < emails.length * 0.95) {
      errors.push(`High duplicate rate: ${emails.length - uniqueEmails} duplicates detected`);
    }

    return {
      passed:         errors.length === 0,
      errors,
      total,
      email_coverage: emailCoverage,
      unique_emails:  uniqueEmails,
    };
  }

  async fetchAudienceRecords(sql) {
    if (this.dryRun) return [{ contact_id: 'DRY_RUN', email: 'test@example.com' }];
    // return await this.db.execute(sql);
    return []; // stub
  }

  async uploadToDestination(destName, destConfig, listId, payload) {
    if (this.dryRun) {
      console.log(`[SYNC][DRY-RUN] Would upload ${payload.length} records to ${destName}:${listId}`);
      return { dry_run: true, records: payload.length };
    }
    console.log(`[SYNC] Uploading ${payload.length} records → ${destName}:${listId}`);
    // Actual upload logic per platform...
    return { uploaded: payload.length, list_id: listId };
  }

  hashSHA256(value) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}

module.exports = { AudienceSyncPipeline, AUDIENCE_MODELS, DESTINATIONS };
