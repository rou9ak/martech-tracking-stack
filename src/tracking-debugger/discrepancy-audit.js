/**
 * Tracking Discrepancy Debugger
 *
 * Systematically identifies and diagnoses:
 *  - GA4 vs Google Ads conversion count mismatches
 *  - Browser pixel vs CAPI event deduplication issues
 *  - CRM lead count vs ad platform conversion mismatches
 *  - Attribution window drift
 *  - Bot / spam traffic contamination
 */

'use strict';

// ─── Discrepancy Thresholds ───────────────────────────────────────────────────

const THRESHOLDS = {
  ACCEPTABLE_VARIANCE_PCT:  0.05,   // 5% — normal de-dup / timezone drift
  WARNING_VARIANCE_PCT:     0.15,   // 15% — investigate
  CRITICAL_VARIANCE_PCT:    0.30,   // 30% — immediate action
  MIN_SAMPLE_SIZE:          50,     // below this, variance is expected
};

// ─── Data Source Connectors (stubbed) ────────────────────────────────────────

const sources = {
  async getGA4Events(eventName, dateRange) {
    // BigQuery: SELECT count(*) FROM analytics_XXX.events_* WHERE event_name = ?
    return { count: 1240, source: 'GA4', event: eventName, ...dateRange };
  },
  async getGoogleAdsConversions(conversionAction, dateRange) {
    // Google Ads API: campaign performance report
    return { count: 1187, source: 'GoogleAds', action: conversionAction, ...dateRange };
  },
  async getMetaPixelEvents(eventName, dateRange) {
    // Meta Events Manager API
    return { count: 890, source: 'MetaPixel', event: eventName, ...dateRange };
  },
  async getMetaCAPIEvents(eventName, dateRange) {
    // Meta CAPI deduplicated count
    return { count: 1205, source: 'MetaCAPI', event: eventName, ...dateRange };
  },
  async getCRMLeads(stage, dateRange) {
    // HubSpot CRM contacts in lifecycle stage
    return { count: 1198, source: 'CRM', stage, ...dateRange };
  },
  async getServerSideLogs(eventName, dateRange) {
    // GTM server container logs / Stape logs
    return { count: 1241, source: 'GTMServer', event: eventName, ...dateRange };
  },
};

// ─── Core Comparison Engine ───────────────────────────────────────────────────

class TrackingDebugger {

  constructor(dateRange) {
    this.dateRange  = dateRange;
    this.findings   = [];
    this.diagnoses  = [];
  }

  // Run all standard discrepancy checks
  async runFullAudit() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' TRACKING DISCREPANCY AUDIT');
    console.log(` Date range: ${this.dateRange.start} → ${this.dateRange.end}`);
    console.log('═══════════════════════════════════════════════════\n');

    await this.checkGA4VsGoogleAds();
    await this.checkMetaDeduplication();
    await this.checkCRMVsAdPlatforms();
    await this.checkServerSideVsBrowser();

    this.printReport();
    return { findings: this.findings, diagnoses: this.diagnoses };
  }

  // ── Check 1: GA4 vs Google Ads Conversion Counts ──────────────────────────

  async checkGA4VsGoogleAds() {
    const [ga4, gads] = await Promise.all([
      sources.getGA4Events('purchase', this.dateRange),
      sources.getGoogleAdsConversions('CONV_CUSTOMER', this.dateRange),
    ]);

    const finding = this.compare('GA4 vs Google Ads (purchase/CONV_CUSTOMER)', ga4.count, gads.count);

    if (finding.severity !== 'ok') {
      finding.possible_causes = [
        'Attribution window mismatch — GA4 uses event-based, GAds uses click-based (30d default)',
        'View-through conversions included in GAds but not GA4',
        'Cross-device conversions counted in GAds, not in GA4 session',
        'GAds conversion delay — last-click vs data-driven model difference',
        'Self-referral / direct traffic crediting GA4 incorrectly',
      ];
      finding.debug_steps = [
        '1. Align attribution windows: GAds → Data-driven, GA4 → Same window',
        '2. Export both to BigQuery and join on transaction_id',
        '3. Check for duplicate transaction_ids in GA4 (refreshed pages)',
        '4. Verify GCLID auto-tagging is enabled in Google Ads',
        '5. Confirm conversion window set to 90 days in GAds for SaaS',
      ];
    }
    this.findings.push(finding);
  }

  // ── Check 2: Meta Browser Pixel vs CAPI Deduplication ─────────────────────

  async checkMetaDeduplication() {
    const [pixel, capi] = await Promise.all([
      sources.getMetaPixelEvents('Lead', this.dateRange),
      sources.getMetaCAPIEvents('Lead', this.dateRange),
    ]);

    const finding = this.compare('Meta Pixel vs CAPI (deduplication)', pixel.count, capi.count);

    // For Meta: CAPI+Pixel combined should be ~same as either alone (dedup working)
    const combined_effective = Math.max(pixel.count, capi.count);
    finding.dedup_analysis = {
      pixel_only:    pixel.count,
      capi_only:     capi.count,
      estimated_combined_without_dedup: pixel.count + capi.count,
      effective_after_dedup:            combined_effective,
      dedup_rate_pct: Math.round((1 - combined_effective / (pixel.count + capi.count)) * 100),
      note: 'event_id must match between pixel and CAPI for deduplication to work',
    };

    if (capi.count < pixel.count * 0.7) {
      finding.possible_causes = [
        'CAPI not firing for server-rendered pages (no client-side trigger)',
        'GTM server tag pausing on ITP/ad-blocker traffic (correct — this is normal)',
        'Missing fbp/fbc cookie forwarding to server container',
        'CAPI endpoint authentication failure (check access token expiry)',
      ];
      finding.debug_steps = [
        '1. Check Meta Events Manager → Test Events tab for CAPI payloads',
        '2. Verify x-fb-cs-endpoint header in Stape proxy config',
        '3. Compare server-side logs with pixel fire count in GA4 DebugView',
        '4. Ensure fbp cookie is forwarded in GTM server client config',
      ];
    }
    this.findings.push(finding);
  }

  // ── Check 3: CRM Lead Count vs Ad Platform Attribution ────────────────────

  async checkCRMVsAdPlatforms() {
    const [crm, gads] = await Promise.all([
      sources.getCRMLeads('marketingqualified', this.dateRange),
      sources.getGoogleAdsConversions('CONV_MQL', this.dateRange),
    ]);

    const finding = this.compare('CRM MQL count vs Google Ads CONV_MQL', crm.count, gads.count);

    finding.context = 'Google Ads will always show FEWER — only shows ad-attributed MQLs, not organic/direct';
    finding.ad_attribution_rate_pct = Math.round((gads.count / crm.count) * 100);

    if (gads.count > crm.count) {
      finding.alert = '🚨 CRITICAL: Ad platform showing MORE conversions than CRM. Check for:';
      finding.possible_causes = [
        'Offline conversion upload counting same deal multiple times (dedup key missing)',
        'Test conversions not filtered in ad platform',
        'Multiple deals per contact all firing conversion',
        'Webhook retries causing duplicate uploads',
      ];
    }
    this.findings.push(finding);
  }

  // ── Check 4: GTM Server vs Browser Event Counts ───────────────────────────

  async checkServerSideVsBrowser() {
    const [server, ga4] = await Promise.all([
      sources.getServerSideLogs('lead_form_submit', this.dateRange),
      sources.getGA4Events('lead_form_submit', this.dateRange),
    ]);

    const finding = this.compare('GTM Server vs GA4 browser (lead_form_submit)', server.count, ga4.count);

    finding.note = 'Server count should be >= GA4 (server fires even when GA4 tag blocks)';

    if (server.count < ga4.count) {
      finding.possible_causes = [
        'Server container not receiving all web container events (URL routing issue)',
        'Stape proxy domain not correctly configured in web GTM transport URL',
        'Events hitting wrong server container (dev vs prod)',
        'GTM server rate limiting or quota exceeded',
      ];
    }
    this.findings.push(finding);
  }

  // ── Comparison Utility ────────────────────────────────────────────────────

  compare(label, countA, countB) {
    const larger    = Math.max(countA, countB);
    const smaller   = Math.min(countA, countB);
    const variance  = larger > 0 ? (larger - smaller) / larger : 0;
    const variancePct = Math.round(variance * 100);

    let severity = 'ok';
    if (variance > THRESHOLDS.CRITICAL_VARIANCE_PCT && larger >= THRESHOLDS.MIN_SAMPLE_SIZE) severity = 'critical';
    else if (variance > THRESHOLDS.WARNING_VARIANCE_PCT && larger >= THRESHOLDS.MIN_SAMPLE_SIZE) severity = 'warning';
    else if (variance > THRESHOLDS.ACCEPTABLE_VARIANCE_PCT) severity = 'info';

    const icon = { ok: '✅', info: 'ℹ️', warning: '⚠️', critical: '🚨' }[severity];

    return { label, countA, countB, variance_pct: variancePct, severity, icon };
  }

  printReport() {
    console.log('FINDINGS SUMMARY\n');
    for (const f of this.findings) {
      console.log(`${f.icon} ${f.label}`);
      console.log(`   Count A: ${f.countA.toLocaleString()} | Count B: ${f.countB.toLocaleString()} | Variance: ${f.variance_pct}%`);
      if (f.possible_causes) {
        console.log('   Possible causes:');
        f.possible_causes.forEach(c => console.log(`    - ${c}`));
      }
      if (f.debug_steps) {
        console.log('   Debug steps:');
        f.debug_steps.forEach(s => console.log(`    ${s}`));
      }
      console.log('');
    }
  }
}

// ─── Quick Diagnostic: Single Event Trace ─────────────────────────────────────

async function traceEventEnd2End(eventId) {
  console.log(`\n[TRACE] Tracing event_id: ${eventId}\n`);
  const trace = {
    event_id: eventId,
    browser_pixel:  { found: true,  timestamp: '2024-03-15T14:22:01Z', fbp: 'fb.1.xxx', fbc: 'fb.2.yyy' },
    gtm_server:     { found: true,  timestamp: '2024-03-15T14:22:02Z', latency_ms: 320 },
    ga4_mp:         { found: true,  event_name: 'lead_form_submit', session_id: 'sess_001' },
    meta_capi:      { found: true,  dedup_with_pixel: true, matched_fbp: true },
    google_ads_api: { found: false, reason: 'No GCLID on this session — organic traffic' },
    crm:            { found: true,  contact_id: 'hs-001', lifecycle_stage: 'lead', created_at: '2024-03-15T14:22:05Z' },
  };

  const missingPlatforms = Object.entries(trace)
    .filter(([k, v]) => k !== 'event_id' && !v.found)
    .map(([k]) => k);

  if (missingPlatforms.length > 0) {
    console.log(`[TRACE] ⚠️  Event not found in: ${missingPlatforms.join(', ')}`);
  } else {
    console.log('[TRACE] ✅ Event found in all expected platforms');
  }

  return trace;
}

module.exports = { TrackingDebugger, traceEventEnd2End, THRESHOLDS };

// Run audit if called directly
if (require.main === module) {
  const debugger_ = new TrackingDebugger({ start: '2024-03-01', end: '2024-03-31' });
  debugger_.runFullAudit().catch(console.error);
}
