#!/usr/bin/env node
/**
 * Travel Advisory Aggregator
 * Fetches from 4 official government sources and consolidates into a single JSON
 * Sources: Australia (Smartraveller), UK (FCDO), USA (State Dept), Canada (GAC)
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'data');

// ─── Risk Level Normalizers ────────────────────────────────────────────────────

const RISK_LEVELS = {
  EXERCISE_NORMAL: { level: 1, label: 'Exercise Normal Precautions', color: '#22c55e' },
  EXERCISE_INCREASED: { level: 2, label: 'Exercise Increased Caution', color: '#f59e0b' },
  RECONSIDER: { level: 3, label: 'Reconsider Travel', color: '#f97316' },
  DO_NOT_TRAVEL: { level: 4, label: 'Do Not Travel', color: '#ef4444' },
  UNKNOWN: { level: 0, label: 'Unknown', color: '#6b7280' },
};

// ─── Source: Canada (Global Affairs Canada) ────────────────────────────────────
// Direct JSON API — no scraping needed, fully structured

async function fetchCanada() {
  console.log('🇨🇦 Fetching Canada (Global Affairs Canada)...');
  const BASE = 'https://data.international.gc.ca/travel-voyage';

  // Fetch index listing to get all country codes
  const indexRes = await fetch(`${BASE}/`, { headers: { 'User-Agent': 'TravelAdvisoryAggregator/1.0' } });
  const indexHtml = await indexRes.text();

  // Extract all country ISO codes from filenames like cta-cap-XX.json
  const codes = [...indexHtml.matchAll(/cta-cap-([A-Z]{2,3})\.json/g)].map(m => m[1]);
  const uniqueCodes = [...new Set(codes)];

  console.log(`  → Found ${uniqueCodes.length} Canadian advisory files`);

  const advisories = [];
  const BATCH = 10;

  for (let i = 0; i < uniqueCodes.length; i += BATCH) {
    const batch = uniqueCodes.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(code =>
        fetch(`${BASE}/cta-cap-${code}.json`, { headers: { 'User-Agent': 'TravelAdvisoryAggregator/1.0' } })
          .then(r => r.json())
          .then(d => parseCanada(d, code))
      )
    );
    results.forEach(r => r.status === 'fulfilled' && r.value && advisories.push(r.value));
    process.stdout.write(`  → Progress: ${Math.min(i + BATCH, uniqueCodes.length)}/${uniqueCodes.length}\r`);
    await sleep(100); // Be respectful to the server
  }

  console.log(`\n  → Parsed ${advisories.length} Canadian advisories`);
  return advisories;
}

function parseCanada(data, code) {
  if (!data?.data) return null;
  const d = data.data;
  const eng = d.eng || {};
  const advisoryState = d['advisory-state'];

  const levelMap = {
    0: RISK_LEVELS.EXERCISE_NORMAL,
    1: RISK_LEVELS.EXERCISE_INCREASED,
    2: RISK_LEVELS.RECONSIDER,
    3: RISK_LEVELS.DO_NOT_TRAVEL,
  };

  return {
    iso2: d['country-iso'] || code,
    country: eng.name || code,
    source: 'Canada',
    sourceUrl: `https://travel.gc.ca/destinations/${eng['url-slug'] || code.toLowerCase()}`,
    riskLevel: (levelMap[advisoryState] || RISK_LEVELS.UNKNOWN).level,
    riskLabel: (levelMap[advisoryState] || RISK_LEVELS.UNKNOWN).label,
    riskColor: (levelMap[advisoryState] || RISK_LEVELS.UNKNOWN).color,
    advisoryText: eng['advisory-text'] || '',
    recentUpdates: eng['recent-updates'] || '',
    hasRegionalAdvisory: !!d['has-regional-advisory'],
    updatedAt: data.metadata?.generated?.date
      ? new Date(data.metadata.generated.date).toISOString()
      : new Date().toISOString(),
    friendlyDate: eng['friendly-date'] || '',
    geoGroup: eng['geo-group'] || '',
  };
}

// ─── Source: Australia (Smartraveller) ────────────────────────────────────────
// Smartraveller publishes a JSON feed

async function fetchAustralia() {
  console.log('🇦🇺 Fetching Australia (Smartraveller)...');

  // Smartraveller has a structured JSON endpoint
  const res = await fetch('https://www.smartraveller.gov.au/api/v1/destinations', {
    headers: {
      'User-Agent': 'TravelAdvisoryAggregator/1.0',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    console.warn(`  ⚠ Australia API returned ${res.status}, trying sitemap fallback`);
    return fetchAustraliaFallback();
  }

  const data = await res.json();
  return parseAustralia(data);
}

async function fetchAustraliaFallback() {
  // Use the destinations listing page + parse structured data
  const res = await fetch('https://www.smartraveller.gov.au/destinations', {
    headers: { 'User-Agent': 'TravelAdvisoryAggregator/1.0' },
  });
  const html = await res.text();

  // Extract JSON-LD structured data
  const jsonLdMatches = [...html.matchAll(/<script type="application\/json"[^>]*>(.*?)<\/script>/gs)];
  const advisories = [];

  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.countries || data?.destinations) {
        const countries = data.countries || data.destinations;
        for (const c of Object.values(countries)) {
          advisories.push(parseAustraliaCountry(c));
        }
      }
    } catch {}
  }

  // Parse drupal-style data-drupal-selector JSON
  const drupalMatch = html.match(/data-drupal-selector="drupal-settings-json"[^>]*>(.*?)<\/script>/s);
  if (drupalMatch) {
    try {
      const drupal = JSON.parse(drupalMatch[1]);
      const destinations = drupal?.smartraveller?.destinations;
      if (destinations) {
        for (const [, c] of Object.entries(destinations)) {
          advisories.push(parseAustraliaCountry(c));
        }
      }
    } catch {}
  }

  console.log(`  → Parsed ${advisories.length} Australian advisories`);
  return advisories;
}

function parseAustralia(data) {
  const advisories = [];
  const countries = data?.countries || data?.data || data || [];
  const arr = Array.isArray(countries) ? countries : Object.values(countries);

  for (const c of arr) {
    const parsed = parseAustraliaCountry(c);
    if (parsed) advisories.push(parsed);
  }

  console.log(`  → Parsed ${advisories.length} Australian advisories`);
  return advisories;
}

function parseAustraliaCountry(c) {
  if (!c) return null;

  // Smartraveller uses levels 1-4
  const levelNum = parseInt(c.level || c.advisory_level || c.alert_level || '0');
  const levelMap = {
    1: RISK_LEVELS.EXERCISE_NORMAL,
    2: RISK_LEVELS.EXERCISE_INCREASED,
    3: RISK_LEVELS.RECONSIDER,
    4: RISK_LEVELS.DO_NOT_TRAVEL,
  };

  return {
    iso2: c.iso || c.iso2 || c.country_code || '',
    country: c.name || c.title || c.country_name || '',
    source: 'Australia',
    sourceUrl: c.url
      ? `https://www.smartraveller.gov.au${c.url}`
      : `https://www.smartraveller.gov.au/destinations/${(c.slug || c.name || '').toLowerCase().replace(/\s+/g, '-')}`,
    riskLevel: (levelMap[levelNum] || RISK_LEVELS.UNKNOWN).level,
    riskLabel: c.level_label || (levelMap[levelNum] || RISK_LEVELS.UNKNOWN).label,
    riskColor: (levelMap[levelNum] || RISK_LEVELS.UNKNOWN).color,
    advisoryText: c.summary || c.advisory_text || c.description || '',
    recentUpdates: c.latest_update || c.recent_update || '',
    hasRegionalAdvisory: !!(c.has_regional || c.partial_travel_advice),
    updatedAt: c.updated_at || c.date_updated || c.last_updated || new Date().toISOString(),
    friendlyDate: c.updated_date_display || '',
    geoGroup: c.region || c.geo_group || '',
  };
}

// ─── Source: United Kingdom (FCDO) ────────────────────────────────────────────
// FCDO provides a JSON feed for travel advisories

async function fetchUK() {
  console.log('🇬🇧 Fetching UK (FCDO)...');

  // FCDO has a structured content API
  const res = await fetch(
    'https://www.gov.uk/api/content/foreign-travel-advice',
    {
      headers: {
        'User-Agent': 'TravelAdvisoryAggregator/1.0',
        Accept: 'application/json',
      },
    }
  );

  if (!res.ok) {
    console.warn(`  ⚠ UK API returned ${res.status}`);
    return [];
  }

  const data = await res.json();
  const links = data?.links?.children || [];
  console.log(`  → Found ${links.length} UK advisories`);

  const advisories = [];
  const BATCH = 8;

  for (let i = 0; i < links.length; i += BATCH) {
    const batch = links.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(link =>
        fetch(`https://www.gov.uk/api/content${link.base_path}`, {
          headers: { 'User-Agent': 'TravelAdvisoryAggregator/1.0', Accept: 'application/json' },
        })
          .then(r => r.json())
          .then(d => parseUK(d))
      )
    );
    results.forEach(r => r.status === 'fulfilled' && r.value && advisories.push(r.value));
    process.stdout.write(`  → Progress: ${Math.min(i + BATCH, links.length)}/${links.length}\r`);
    await sleep(150);
  }

  console.log(`\n  → Parsed ${advisories.length} UK advisories`);
  return advisories;
}

function parseUK(data) {
  if (!data?.title) return null;

  const details = data.details || {};
  const parts = data.base_path?.split('/') || [];
  const slug = parts[parts.length - 1] || '';

  // Extract alert status from the parts content
  let riskLevel = RISK_LEVELS.UNKNOWN;
  const alertStatus = details.alert_status || [];
  if (Array.isArray(alertStatus)) {
    if (alertStatus.includes('avoid_all_travel_to_whole_country')) riskLevel = RISK_LEVELS.DO_NOT_TRAVEL;
    else if (alertStatus.includes('avoid_all_travel_to_parts_of_country')) riskLevel = RISK_LEVELS.RECONSIDER;
    else if (alertStatus.includes('avoid_non_essential_travel_to_whole_country')) riskLevel = RISK_LEVELS.RECONSIDER;
    else if (alertStatus.includes('avoid_non_essential_travel_to_parts_of_country')) riskLevel = RISK_LEVELS.EXERCISE_INCREASED;
    else if (alertStatus.length === 0) riskLevel = RISK_LEVELS.EXERCISE_NORMAL;
  }

  // Extract country from links
  const countryLink = data.links?.world_locations?.[0];
  const iso2 = countryLink?.details?.iso2 || '';

  return {
    iso2,
    country: data.title?.replace(' travel advice', '') || slug,
    source: 'UK',
    sourceUrl: `https://www.gov.uk${data.base_path || '/foreign-travel-advice'}`,
    riskLevel: riskLevel.level,
    riskLabel: riskLevel.label,
    riskColor: riskLevel.color,
    advisoryText: details.summary || '',
    recentUpdates: details.change_description || '',
    hasRegionalAdvisory: alertStatus.some(s => s.includes('parts_of_country')),
    updatedAt: data.public_updated_at || data.updated_at || new Date().toISOString(),
    friendlyDate: data.public_updated_at
      ? new Date(data.public_updated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : '',
    geoGroup: data.links?.world_locations?.[0]?.details?.region || '',
  };
}

// ─── Source: USA (State Department) ───────────────────────────────────────────
// State Department provides a structured JSON feed

async function fetchUSA() {
  console.log('🇺🇸 Fetching USA (State Department)...');

  // State Dept has an undocumented but stable JSON endpoint
  const endpoints = [
    'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html/_jcr_content/par/adobexf_fragment/adobexf/content/par/advi_list',
    'https://travel.state.gov/api/traveladvisories',
  ];

  // Primary: RSS/JSON feed
  const rssRes = await fetch(
    'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html.tp-atom.xml',
    { headers: { 'User-Agent': 'TravelAdvisoryAggregator/1.0' } }
  );

  if (rssRes.ok) {
    const xml = await rssRes.text();
    return parseUSARss(xml);
  }

  // Fallback: HTML scrape of the advisories list
  console.warn('  ⚠ USA RSS fallback, trying HTML...');
  const htmlRes = await fetch('https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html', {
    headers: { 'User-Agent': 'TravelAdvisoryAggregator/1.0' },
  });

  if (!htmlRes.ok) {
    console.error('  ✗ USA: All endpoints failed');
    return [];
  }

  const html = await htmlRes.text();
  return parseUSAHtml(html);
}

function parseUSARss(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const advisories = [];

  for (const [, item] of items) {
    const title = extractXml(item, 'title');
    const link = extractXml(item, 'link');
    const description = extractXml(item, 'description');
    const pubDate = extractXml(item, 'pubDate');

    if (!title) continue;

    // Parse "Country Name - Level N: Label" format
    const levelMatch = title.match(/Level\s+(\d+)\s*:\s*(.+)/i);
    const countryMatch = title.match(/^(.+?)\s*[-–]\s*Level/i);

    const levelNum = levelMatch ? parseInt(levelMatch[1]) : 0;
    const levelLabel = levelMatch ? levelMatch[2].trim() : '';
    const country = countryMatch ? countryMatch[1].trim() : title;

    const levelMap = {
      1: RISK_LEVELS.EXERCISE_NORMAL,
      2: RISK_LEVELS.EXERCISE_INCREASED,
      3: RISK_LEVELS.RECONSIDER,
      4: RISK_LEVELS.DO_NOT_TRAVEL,
    };

    const risk = levelMap[levelNum] || RISK_LEVELS.UNKNOWN;

    advisories.push({
      iso2: '',
      country,
      source: 'USA',
      sourceUrl: link || 'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html',
      riskLevel: risk.level,
      riskLabel: levelLabel || risk.label,
      riskColor: risk.color,
      advisoryText: description?.replace(/<[^>]+>/g, '') || '',
      recentUpdates: '',
      hasRegionalAdvisory: false,
      updatedAt: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
      friendlyDate: pubDate ? new Date(pubDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '',
      geoGroup: '',
    });
  }

  console.log(`  → Parsed ${advisories.length} USA advisories`);
  return advisories;
}

function parseUSAHtml(html) {
  // Extract from the advisories table/list in HTML
  const rows = [...html.matchAll(/<tr[^>]*class="[^"]*row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)];
  const advisories = [];

  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
      m[1].replace(/<[^>]+>/g, '').trim()
    );

    if (cells.length < 2) continue;

    const country = cells[0];
    const levelText = cells[1] || '';
    const levelNum = parseInt(levelText.match(/\d+/)?.[0] || '0');

    const levelMap = {
      1: RISK_LEVELS.EXERCISE_NORMAL,
      2: RISK_LEVELS.EXERCISE_INCREASED,
      3: RISK_LEVELS.RECONSIDER,
      4: RISK_LEVELS.DO_NOT_TRAVEL,
    };

    const risk = levelMap[levelNum] || RISK_LEVELS.UNKNOWN;
    const linkMatch = row.match(/href="([^"]+)"/);

    advisories.push({
      iso2: '',
      country,
      source: 'USA',
      sourceUrl: linkMatch
        ? `https://travel.state.gov${linkMatch[1]}`
        : 'https://travel.state.gov/content/travel/en/traveladvisories/traveladvisories.html',
      riskLevel: risk.level,
      riskLabel: risk.label,
      riskColor: risk.color,
      advisoryText: '',
      recentUpdates: cells[2] || '',
      hasRegionalAdvisory: false,
      updatedAt: new Date().toISOString(),
      friendlyDate: cells[2] || '',
      geoGroup: '',
    });
  }

  console.log(`  → Parsed ${advisories.length} USA advisories (HTML)`);
  return advisories;
}

// ─── Consolidation & Deduplication ────────────────────────────────────────────

function consolidate(allAdvisories) {
  // Group by country name (normalized)
  const byCountry = new Map();

  for (const advisory of allAdvisories) {
    if (!advisory?.country) continue;
    const key = normalizeCountryName(advisory.country);
    if (!byCountry.has(key)) byCountry.set(key, []);
    byCountry.get(key).push(advisory);
  }

  const consolidated = [];

  for (const [normalizedName, entries] of byCountry) {
    // Derive consensus ISO2 code
    const iso2 = entries.find(e => e.iso2)?.iso2 || '';

    // Compute max risk across all sources
    const maxRisk = Math.max(...entries.map(e => e.riskLevel || 0));
    const highestEntry = entries.find(e => e.riskLevel === maxRisk) || entries[0];

    // Build per-source breakdown
    const sources = {};
    for (const e of entries) {
      sources[e.source] = {
        riskLevel: e.riskLevel,
        riskLabel: e.riskLabel,
        riskColor: e.riskColor,
        advisoryText: e.advisoryText,
        recentUpdates: e.recentUpdates,
        hasRegionalAdvisory: e.hasRegionalAdvisory,
        updatedAt: e.updatedAt,
        friendlyDate: e.friendlyDate,
        sourceUrl: e.sourceUrl,
      };
    }

    // Risk agreement score (how many sources agree on the highest level)
    const agreementCount = entries.filter(e => e.riskLevel === maxRisk).length;
    const consensus = agreementCount / entries.length;

    consolidated.push({
      id: normalizedName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
      iso2,
      country: highestEntry.country,
      normalizedName,
      geoGroup: entries.find(e => e.geoGroup)?.geoGroup || '',

      // Consensus risk (highest observed)
      maxRiskLevel: maxRisk,
      maxRiskLabel: highestEntry.riskLabel,
      maxRiskColor: highestEntry.riskColor,

      // Consensus stats
      sourceCount: entries.length,
      sourceAgreement: Math.round(consensus * 100),
      hasRegionalAdvisory: entries.some(e => e.hasRegionalAdvisory),

      // Per-source data
      sources,

      // Timestamps
      lastUpdated: entries
        .map(e => e.updatedAt)
        .filter(Boolean)
        .sort()
        .reverse()[0] || new Date().toISOString(),
    });
  }

  // Sort: highest risk first, then alphabetically
  consolidated.sort((a, b) => {
    if (b.maxRiskLevel !== a.maxRiskLevel) return b.maxRiskLevel - a.maxRiskLevel;
    return a.country.localeCompare(b.country);
  });

  return consolidated;
}

function normalizeCountryName(name) {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(The\s+)/i, '')
    .toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function extractXml(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? (match[1] || match[2] || '').trim() : '';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Travel Advisory Aggregator v2.0            ║');
  console.log('║   Running at:', new Date().toISOString(), '║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const [canada, australia, uk, usa] = await Promise.allSettled([
    fetchCanada(),
    fetchAustralia(),
    fetchUK(),
    fetchUSA(),
  ]);

  const allAdvisories = [
    ...(canada.status === 'fulfilled' ? canada.value : []),
    ...(australia.status === 'fulfilled' ? australia.value : []),
    ...(uk.status === 'fulfilled' ? uk.value : []),
    ...(usa.status === 'fulfilled' ? usa.value : []),
  ].filter(Boolean);

  console.log(`\n📊 Total raw advisories: ${allAdvisories.length}`);

  // Source stats
  const sourceCounts = allAdvisories.reduce((acc, a) => {
    acc[a.source] = (acc[a.source] || 0) + 1;
    return acc;
  }, {});
  console.log('   Per source:', sourceCounts);

  const consolidated = consolidate(allAdvisories);
  console.log(`\n🌍 Consolidated unique countries: ${consolidated.length}`);

  // Risk distribution
  const riskDist = consolidated.reduce((acc, c) => {
    acc[c.maxRiskLevel] = (acc[c.maxRiskLevel] || 0) + 1;
    return acc;
  }, {});
  console.log('   Risk distribution:', {
    'Level 1 (Normal)': riskDist[1] || 0,
    'Level 2 (Caution)': riskDist[2] || 0,
    'Level 3 (Reconsider)': riskDist[3] || 0,
    'Level 4 (Do Not Travel)': riskDist[4] || 0,
  });

  // Build output
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const output = {
    metadata: {
      generatedAt: new Date().toISOString(),
      version: '2.0',
      sources: {
        canada: { name: 'Global Affairs Canada', url: 'https://travel.gc.ca', count: sourceCounts.Canada || 0 },
        australia: { name: 'Smartraveller (DFAT)', url: 'https://www.smartraveller.gov.au', count: sourceCounts.Australia || 0 },
        uk: { name: 'FCDO (UK Gov)', url: 'https://www.gov.uk/foreign-travel-advice', count: sourceCounts.UK || 0 },
        usa: { name: 'US State Department', url: 'https://travel.state.gov', count: sourceCounts.USA || 0 },
      },
      totalCountries: consolidated.length,
      riskDistribution: {
        level1Normal: riskDist[1] || 0,
        level2Caution: riskDist[2] || 0,
        level3Reconsider: riskDist[3] || 0,
        level4DoNotTravel: riskDist[4] || 0,
      },
    },
    advisories: consolidated,
  };

  // Write consolidated JSON
  const outputPath = join(OUTPUT_DIR, 'travel-advisories.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ Written to: ${outputPath}`);

  // Write summary CSV
  const csvPath = join(OUTPUT_DIR, 'travel-advisories-summary.csv');
  const csvHeader = 'ISO2,Country,GeoGroup,MaxRiskLevel,MaxRiskLabel,SourceCount,HasRegionalAdvisory,LastUpdated,Canada_Level,UK_Level,USA_Level,Australia_Level\n';
  const csvRows = consolidated.map(c => [
    c.iso2,
    `"${c.country}"`,
    `"${c.geoGroup}"`,
    c.maxRiskLevel,
    `"${c.maxRiskLabel}"`,
    c.sourceCount,
    c.hasRegionalAdvisory,
    c.lastUpdated,
    c.sources.Canada?.riskLevel ?? '',
    c.sources.UK?.riskLevel ?? '',
    c.sources.USA?.riskLevel ?? '',
    c.sources.Australia?.riskLevel ?? '',
  ].join(',')).join('\n');
  writeFileSync(csvPath, csvHeader + csvRows);
  console.log(`✅ CSV written to: ${csvPath}`);

  // Write lightweight index (for fast dashboard loading)
  const indexPath = join(OUTPUT_DIR, 'travel-advisories-index.json');
  const index = {
    metadata: output.metadata,
    advisories: consolidated.map(c => ({
      id: c.id,
      iso2: c.iso2,
      country: c.country,
      geoGroup: c.geoGroup,
      maxRiskLevel: c.maxRiskLevel,
      maxRiskLabel: c.maxRiskLabel,
      maxRiskColor: c.maxRiskColor,
      sourceCount: c.sourceCount,
      hasRegionalAdvisory: c.hasRegionalAdvisory,
      lastUpdated: c.lastUpdated,
      sourceLevels: Object.fromEntries(
        Object.entries(c.sources).map(([src, d]) => [src, d.riskLevel])
      ),
    })),
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`✅ Index written to: ${indexPath}`);

  console.log('\n🎉 Aggregation complete!\n');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
