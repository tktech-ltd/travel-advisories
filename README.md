# 🌍 Global Travel Advisory Aggregator

[![Aggregate Advisories](https://github.com/YOUR_ORG/travel-advisories/actions/workflows/aggregate.yml/badge.svg)](https://github.com/YOUR_ORG/travel-advisories/actions/workflows/aggregate.yml)
[![Data Updated](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/YOUR_ORG/travel-advisories/main/data/travel-advisories-index.json&query=$.metadata.generatedAt&label=Last%20Updated&color=22c55e)](./data/travel-advisories-index.json)
[![Countries](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/YOUR_ORG/travel-advisories/main/data/travel-advisories-index.json&query=$.metadata.totalCountries&label=Countries&color=7c6fff)](./data/travel-advisories-index.json)

> Automated aggregation of official government travel advisories from **4 sources**, consolidated every **6 hours**, served as structured JSON with a live dashboard.

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                  GitHub Actions (cron: */6h)             │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ 🇨🇦 Canada │  │ 🇦🇺 Austr. │  │ 🇬🇧 UK   │  │ 🇺🇸 USA │  │
│  │ JSON API  │  │ JSON API  │  │ GOV API  │  │  RSS   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬───┘  │
│       └─────────────┴─────────────┴──────────────┘      │
│                           │                              │
│                    ┌──────▼──────┐                       │
│                    │  Aggregator │  Node.js ESM          │
│                    │  + Deduper  │  Zero dependencies     │
│                    └──────┬──────┘                       │
│                           │                              │
│         ┌─────────────────┼────────────────┐            │
│         ▼                 ▼                ▼            │
│  travel-advisories  travel-advisories  travel-advisories │
│  .json (full)       -index.json (fast) -summary.csv      │
│                                                          │
│              Git commit → Push → GitHub Pages            │
└─────────────────────────────────────────────────────────┘
```

## 📡 Data Sources

| Source | Method | Countries | Update Freq |
|--------|--------|-----------|-------------|
| 🇨🇦 [Global Affairs Canada](https://travel.gc.ca) | Direct JSON API (`cta-cap-{ISO}.json`) | ~230 | 6h |
| 🇦🇺 [Smartraveller (DFAT)](https://www.smartraveller.gov.au) | JSON API + HTML fallback | ~170 | 6h |
| 🇬🇧 [FCDO (UK Gov)](https://www.gov.uk/foreign-travel-advice) | GOV.UK Content API | ~200 | 6h |
| 🇺🇸 [US State Department](https://travel.state.gov) | RSS feed + HTML fallback | ~200 | 6h |

## 📁 Output Files

### `data/travel-advisories.json` — Full consolidated dataset
```json
{
  "metadata": {
    "generatedAt": "2026-03-30T12:00:00.000Z",
    "version": "2.0",
    "sources": { "canada": { "count": 228 }, "uk": { "count": 195 }, ... },
    "totalCountries": 252,
    "riskDistribution": {
      "level4DoNotTravel": 15,
      "level3Reconsider": 32,
      "level2Caution": 68,
      "level1Normal": 137
    }
  },
  "advisories": [
    {
      "id": "afghanistan",
      "iso2": "AF",
      "country": "Afghanistan",
      "geoGroup": "Asia",
      "maxRiskLevel": 4,
      "maxRiskLabel": "Do Not Travel",
      "maxRiskColor": "#ef4444",
      "sourceCount": 4,
      "sourceAgreement": 100,
      "hasRegionalAdvisory": false,
      "sources": {
        "Canada": { "riskLevel": 4, "advisoryText": "...", "updatedAt": "...", "sourceUrl": "..." },
        "UK":     { "riskLevel": 4, "advisoryText": "...", "updatedAt": "...", "sourceUrl": "..." },
        "USA":    { "riskLevel": 4, "advisoryText": "...", "updatedAt": "...", "sourceUrl": "..." },
        "Australia": { "riskLevel": 4, "advisoryText": "...", "updatedAt": "...", "sourceUrl": "..." }
      },
      "lastUpdated": "2026-03-30T06:00:00.000Z"
    }
  ]
}
```

### `data/travel-advisories-index.json` — Lightweight index (fast loading)
Same structure but `sources` only contains `riskLevel` per source — ideal for dashboards.

### `data/travel-advisories-summary.csv` — CSV for spreadsheet tools
```csv
ISO2,Country,GeoGroup,MaxRiskLevel,MaxRiskLabel,SourceCount,HasRegionalAdvisory,LastUpdated,...
AF,Afghanistan,Asia,4,Do Not Travel,4,false,2026-03-30T06:00:00Z,...
```

## 🚀 Setup

### 1. Fork this repository

### 2. Enable GitHub Pages
- Settings → Pages → Source: **GitHub Actions**

### 3. Grant Actions write permissions
- Settings → Actions → General → Workflow permissions → **Read and write**

### 4. Run first aggregation
```
Actions → "Aggregate Travel Advisories" → Run workflow
```

That's it. Data auto-updates every 6 hours. Dashboard auto-deploys.

## 🖥 Dashboard

Live at: `https://YOUR_ORG.github.io/travel-advisories/`

Features:
- 🔍 Search by country name or ISO code
- 🎚 Filter by risk level (1–4)
- 🌐 Filter by source (Canada / UK / USA / Australia)
- 📊 Side-by-side source comparison with visual risk bars
- ⚠️ Regional advisory indicators
- 🔗 Direct links to official government pages

## 🛠 Local Development

```bash
# Run aggregator locally
cd scripts
npm ci
node scraper.js

# Serve dashboard
npx serve . -p 3000
# Open: http://localhost:3000/dashboard/
```

## 🔔 Notifications (Optional Extension)

The workflow detects Level 4 risk changes and exposes them as outputs.
Wire up Slack/email by adding a step to `.github/workflows/aggregate.yml`:

```yaml
- name: Slack Alert
  if: steps.check.outputs.has_level4 == 'true'
  uses: slackapi/slack-github-action@v1
  with:
    payload: |
      {"text": "🔴 Level 4 alert: ${{ steps.check.outputs.countries }}"}
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

## 📊 Risk Level Reference

| Level | Label | Canada | UK | USA | Australia |
|-------|-------|--------|----|-----|-----------|
| 1 | Exercise Normal Precautions | Normal | No alert | Level 1 | Exercise normal safety |
| 2 | Exercise Increased Caution | High Degree | Non-essential (partial) | Level 2 | Exercise a high degree |
| 3 | Reconsider Travel | Avoid Non-Essential | Non-essential (whole) | Level 3 | Reconsider |
| 4 | Do Not Travel | Avoid All | Avoid all | Level 4 | Do not travel |

---

**Data is fetched from official government sources. Always verify with the official websites before travel.**
